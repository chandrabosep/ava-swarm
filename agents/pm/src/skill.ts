// PM-side skill runtime — pulls installed skills out of the `skills`
// table at tick time and exposes them to the LLM as a single tool.
//
// Persistence + register/heartbeat live in agents/api/src/skills.ts. This
// file is the read-side runtime that bridges the DB to the LLM tool loop:
//
//   1. loadSkillsForAgent('pm') → list of usable skills (those that
//      have an api key and at least one allowed host).
//   2. buildSkillTool(skills)   → one OpenAI tool definition. The model
//      picks which skill to hit via a `skill` argument (one of the
//      installed skill names). One tool > N tools because LLMs choke on
//      tool inflation.
//   3. invokeCallSkillApi(skills, rawArgs) → executes one tool call.
//      Looks up the named skill, validates the URL host against that
//      skill's allowlist, attaches the skill's stored Bearer key
//      server-side, returns a JSON-safe result the model can react to.
//
// Why allowlist hosts at runtime when the api server already verified
// them at install time? Defense in depth: the row could be edited
// out-of-band (DB tooling, future migrations). Re-checking on every
// outbound request keeps the security boundary close to the action.

import type OpenAI from 'openai';

import { db, type AgentRole } from '@swarm/shared';

const MAX_TOOL_RESPONSE_CHARS = 4000;
const TOOL_TIMEOUT_MS = 15_000;

export interface InstalledSkill {
  id: string;
  name: string;
  version: string | null;
  description: string | null;
  /** Full SKILL.md text — injected into the system prompt. */
  content: string;
  /** Hosts the skill is allowed to call. */
  allowedHosts: string[];
  /** Server-only; used to attach Authorization on outbound calls. */
  apiKey: string;
  apiBase: string | null;
  claimStatus: string;
}

/**
 * Load every skill that's installed for `role`, has an apiKey, and lists
 * at least one callable host. Skills without those are dropped from the
 * tool surface — the LLM can't usefully call something we have no creds
 * for or no destination on.
 */
export async function loadSkillsForAgent(role: AgentRole): Promise<InstalledSkill[]> {
  const rows = await db().skill.findMany({
    where: { agentRole: role, apiKey: { not: null } },
    orderBy: { installedAt: 'asc' },
  });
  const usable: InstalledSkill[] = [];
  for (const row of rows) {
    if (!row.apiKey) continue;
    const allowedHosts = row.allowedHosts.split(',').filter(Boolean);
    if (allowedHosts.length === 0) continue;
    usable.push({
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description,
      content: row.content,
      allowedHosts,
      apiKey: row.apiKey,
      apiBase: row.apiBase,
      claimStatus: row.claimStatus,
    });
  }
  return usable;
}

/**
 * One tool, multi-skill. The model selects via the `skill` arg. Putting
 * the skill list directly in the description is more reliable than
 * minting one tool per skill — Hermes 4 (and Llama 3.3) handle a single
 * well-described tool better than 5 thinly-described ones.
 */
export function buildSkillTool(
  skills: InstalledSkill[],
): OpenAI.Chat.Completions.ChatCompletionTool {
  const skillList = skills
    .map(
      (s) =>
        `  - "${s.name}"${s.version ? ` v${s.version}` : ''}: ${s.description ?? '(no description)'}\n    allowed hosts: ${s.allowedHosts.join(', ')}\n    api base: ${s.apiBase ?? '(none)'}\n    claim: ${s.claimStatus}`,
    )
    .join('\n');
  const validNames = skills.map((s) => s.name);
  return {
    type: 'function',
    function: {
      name: 'call_skill_api',
      description:
        `Invoke an HTTP endpoint on one of the installed skills. The skill's ` +
        `API key is attached server-side as a Bearer token — never put ` +
        `credentials in any argument. Requests are rejected unless the URL ` +
        `host is on the chosen skill's allowlist.\n\n` +
        `Installed skills:\n${skillList}\n\n` +
        `Use this to fetch live context that helps you decide your next ` +
        `action (e.g. social signals, market commentary, data feeds the ` +
        `skill exposes).`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skill: {
            type: 'string',
            enum: validNames,
            description: 'Name of the installed skill to call.',
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          },
          url: {
            type: 'string',
            description:
              "Full https:// URL on one of the chosen skill's allowed hosts.",
          },
          body: {
            type: 'object',
            description: 'JSON body for POST/PUT/PATCH. Omit for GET/DELETE.',
            additionalProperties: true,
          },
          headers: {
            type: 'object',
            description:
              'Extra request headers. Authorization is added automatically.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['skill', 'method', 'url'],
      },
    },
  };
}

interface CallSkillApiArgs {
  skill?: string;
  method?: string;
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface SkillCallResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
  url?: string;
  durationMs?: number;
  skill?: string;
}

/**
 * Execute one `call_skill_api` tool call. Never throws — returns a
 * structured result so the LLM can recover from any failure mode.
 */
export async function invokeCallSkillApi(
  skills: InstalledSkill[],
  rawArgs: string,
): Promise<SkillCallResult> {
  let args: CallSkillApiArgs;
  try {
    args = JSON.parse(rawArgs) as CallSkillApiArgs;
  } catch {
    return { ok: false, error: 'tool args were not valid JSON' };
  }

  const skillName = typeof args.skill === 'string' ? args.skill : '';
  const skill = skills.find((s) => s.name === skillName);
  if (!skill) {
    return {
      ok: false,
      error: `unknown skill "${skillName}". installed: [${skills.map((s) => s.name).join(', ')}]`,
    };
  }

  const method = (args.method ?? 'GET').toUpperCase();
  const url = typeof args.url === 'string' ? args.url : '';
  if (!url) return { ok: false, skill: skill.name, error: 'url is required' };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, skill: skill.name, error: `not a valid URL: ${url}` };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      skill: skill.name,
      error: `unsupported protocol: ${parsed.protocol}`,
    };
  }
  const host = parsed.hostname.toLowerCase();
  if (!skill.allowedHosts.includes(host)) {
    return {
      ok: false,
      skill: skill.name,
      error: `host ${host} not on skill allowlist: [${skill.allowedHosts.join(', ')}]`,
    };
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(args.headers ?? {}),
  };
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'authorization') delete headers[k];
  }
  headers['Authorization'] = `Bearer ${skill.apiKey}`;

  const init: RequestInit = { method, headers };
  if (args.body !== undefined && method !== 'GET' && method !== 'DELETE') {
    init.body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
  init.signal = controller.signal;

  const started = Date.now();
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      body:
        text.length > MAX_TOOL_RESPONSE_CHARS
          ? text.slice(0, MAX_TOOL_RESPONSE_CHARS) + '\n…[truncated]'
          : text,
      url,
      durationMs: Date.now() - started,
      skill: skill.name,
    };
  } catch (err) {
    return {
      ok: false,
      skill: skill.name,
      error:
        err instanceof Error
          ? err.name === 'AbortError'
            ? `timed out after ${TOOL_TIMEOUT_MS}ms`
            : err.message
          : String(err),
      url,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the system-prompt section that introduces all installed skills
 * to the LLM. Each skill gets its full SKILL.md (truncated) so the
 * model has the docs in-context.
 */
export function buildSkillsSystemSection(skills: InstalledSkill[]): string {
  if (skills.length === 0) return '';
  const sections = skills.map((s) => {
    const header = s.name && s.version ? `${s.name} v${s.version}` : s.name;
    const truncated =
      s.content.length > 16_000
        ? s.content.slice(0, 16_000) + '\n…[skill body truncated]'
        : s.content;
    return `### ${header}
Description: ${s.description ?? '(none)'}
Allowed hosts: ${s.allowedHosts.join(', ')}
Claim status: ${s.claimStatus}

--- BEGIN ${s.name}/SKILL.md ---
${truncated}
--- END ${s.name}/SKILL.md ---`;
  });
  return `External skills are installed and available via the \`call_skill_api\` tool.

You may call those endpoints to fetch fresh context before making your
decision. The skill's API key is attached server-side; never put
credentials in tool arguments.

${sections.join('\n\n')}`;
}
