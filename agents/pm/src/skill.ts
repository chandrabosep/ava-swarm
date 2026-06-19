// Hermes-style skill runtime — the bridge between the Skill Connector
// (UI paste of SKILL.md + API key, persisted in `swarm_settings`) and the
// PM tick that actually drives the LLM.
//
// Today the Skill Connector is storage-only. This module makes it
// functional:
//
//   1. loadInstalledSkill()  — pull the row out of Postgres, parse a
//      host allowlist out of the markdown body so we know which domains
//      the skill is allowed to talk to.
//   2. callSkillApiTool()    — an OpenAI tool definition the model can
//      call to hit the skill's HTTP API. Server-side proxied so the
//      stored API key never enters an LLM prompt.
//   3. invokeCallSkillApi()  — execute one tool call. Allowlist-checked
//      against the parsed hosts, attaches the API key as a Bearer token,
//      bounds the response size so a chatty endpoint can't blow context.
//
// Why allowlist hosts? The skill markdown is user-pasted, not vetted.
// We don't want a malicious skill to convince the model to POST the
// stored API key (or anything else) to attacker-controlled infra. We
// extract https URLs from the SKILL.md once at load time and refuse any
// tool call that targets a host outside that set.

import type OpenAI from 'openai';

import { db } from '@swarm/shared';

const MAX_TOOL_RESPONSE_CHARS = 4000;
const TOOL_TIMEOUT_MS = 15_000;

export interface InstalledSkill {
  name: string | null;
  version: string | null;
  description: string | null;
  /** Full SKILL.md content (frontmatter + body). */
  content: string;
  /** Stored API key, or null. Service-scoped — only ever sent to allowedHosts. */
  apiKey: string | null;
  /** Hosts the model is allowed to call_skill_api against. Derived from the SKILL.md body. */
  allowedHosts: string[];
}

/**
 * Load the single installed skill (id=`global`) from Postgres. Returns
 * null when no skill is installed — callers fall back to the standard
 * skill-less prompt path.
 */
export async function loadInstalledSkill(): Promise<InstalledSkill | null> {
  const row = await db().swarmSettings.findUnique({ where: { id: 'global' } });
  if (!row?.skillContent) return null;

  return {
    name: row.skillName,
    version: row.skillVersion,
    description: row.skillDescription,
    content: row.skillContent,
    apiKey: row.skillApiKey,
    allowedHosts: extractHosts(row.skillContent),
  };
}

/**
 * Find every distinct https host referenced in the skill markdown. The
 * model can only invoke `call_skill_api` against URLs whose host is in
 * this set, so a skill that doesn't mention any host can't drive
 * outbound traffic at all.
 */
export function extractHosts(content: string): string[] {
  const out = new Set<string>();
  const re = /https?:\/\/([a-zA-Z0-9.\-]+)(?::\d+)?(?:\/|\b)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const host = m[1].toLowerCase();
    // Skip example/placeholder hosts that often appear in docs.
    if (host === 'example.com' || host === 'localhost') continue;
    out.add(host);
  }
  return [...out];
}

/**
 * The single tool definition we expose to a Hermes-driven PM tick.
 * Description is intentionally explicit about the allowlist so the
 * model doesn't waste turns trying URLs that will be rejected.
 */
export function callSkillApiTool(
  skill: InstalledSkill,
): OpenAI.Chat.Completions.ChatCompletionTool {
  const hostList =
    skill.allowedHosts.length > 0
      ? skill.allowedHosts.join(', ')
      : '(none — skill listed no callable hosts)';
  return {
    type: 'function',
    function: {
      name: 'call_skill_api',
      description:
        `Invoke an HTTP endpoint on the installed skill (${skill.name ?? 'unnamed'}` +
        `${skill.version ? ` v${skill.version}` : ''}). The skill's API key is ` +
        `attached server-side as a Bearer token — do not put credentials in any ` +
        `argument. Requests are rejected unless the URL host is one of: ${hostList}. ` +
        `Use this to fetch fresh context that helps you decide the allocation ` +
        `(e.g. signals, news, on-chain data the skill exposes).`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            description: 'HTTP method.',
          },
          url: {
            type: 'string',
            description:
              'Full https:// URL on one of the allowed hosts. Path/query inline.',
          },
          body: {
            type: 'object',
            description: 'JSON body for POST/PUT/PATCH. Omit for GET/DELETE.',
            additionalProperties: true,
          },
          headers: {
            type: 'object',
            description:
              'Extra request headers. Authorization is added automatically — do not set it here.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['method', 'url'],
      },
    },
  };
}

interface CallSkillApiArgs {
  method?: string;
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface SkillCallResult {
  ok: boolean;
  status?: number;
  /** Body, truncated to MAX_TOOL_RESPONSE_CHARS. */
  body?: string;
  /** Set when the call short-circuited before/after the request. */
  error?: string;
  url?: string;
  durationMs?: number;
}

/**
 * Execute one `call_skill_api` tool call. Never throws — always returns
 * a structured result the model can react to (the model is much better
 * at recovering from a JSON error payload than from a raised exception
 * in the tool loop).
 */
export async function invokeCallSkillApi(
  skill: InstalledSkill,
  rawArgs: string,
): Promise<SkillCallResult> {
  let args: CallSkillApiArgs;
  try {
    args = JSON.parse(rawArgs) as CallSkillApiArgs;
  } catch {
    return { ok: false, error: 'tool args were not valid JSON' };
  }

  const method = (args.method ?? 'GET').toUpperCase();
  const url = typeof args.url === 'string' ? args.url : '';
  if (!url) return { ok: false, error: 'url is required' };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `not a valid URL: ${url}` };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: `unsupported protocol: ${parsed.protocol}` };
  }
  const host = parsed.hostname.toLowerCase();
  if (!skill.allowedHosts.includes(host)) {
    return {
      ok: false,
      error: `host ${host} not on skill allowlist: [${skill.allowedHosts.join(', ')}]`,
    };
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(args.headers ?? {}),
  };
  // Strip any Authorization the model tried to set — we own that header.
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'authorization') delete headers[k];
  }
  if (skill.apiKey) headers['Authorization'] = `Bearer ${skill.apiKey}`;

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
    };
  } catch (err) {
    return {
      ok: false,
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
 * Build the system-prompt section that introduces the skill to the model.
 * Kept as its own function so decide.ts can compose it cleanly.
 */
export function buildSkillSystemSection(skill: InstalledSkill): string {
  const header =
    skill.name && skill.version
      ? `${skill.name} v${skill.version}`
      : (skill.name ?? 'unnamed skill');
  const allow =
    skill.allowedHosts.length > 0
      ? skill.allowedHosts.join(', ')
      : '(skill listed no hosts — call_skill_api will reject everything)';

  // Cap content at 24KB — Hermes context is roomy but we're not paying
  // to ship megabytes of skill markdown every tick.
  const content =
    skill.content.length > 24_000
      ? skill.content.slice(0, 24_000) + '\n…[skill body truncated]'
      : skill.content;

  return `An external skill is installed and available to you.

Skill: ${header}
Description: ${skill.description ?? '(none)'}
Allowed hosts: ${allow}

You may call the \`call_skill_api\` tool to fetch fresh context from this
skill before making your allocation decision. The skill's own API key is
attached server-side; never put credentials in tool arguments. After any
tool calls, return ONLY the final allocation JSON — no commentary.

--- BEGIN SKILL.md ---
${content}
--- END SKILL.md ---`;
}
