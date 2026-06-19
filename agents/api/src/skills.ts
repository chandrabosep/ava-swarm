// Skill connector — discovery, self-registration, heartbeat polling.
//
// Lifecycle of a skill:
//   1. INSTALL  — user pastes (or links) a SKILL.md and picks an agent
//      role. The server parses YAML frontmatter + scans the body for
//      register/status URLs + extracts a host allowlist for the LLM
//      tool loop. Persists everything on a `skills` row.
//
//   2. REGISTER — server immediately POSTs the discovered register
//      endpoint with `{name, description}` derived from the swarm's
//      identity. The response carries the long-lived API key (server-
//      only — never to the UI), a `claim_url` the human visits to verify
//      ownership on the skill's own site, and a short `verification_code`.
//
//   3. CLAIM    — out-of-band: the human follows claim_url, completes
//      whatever flow the skill requires (Twitter post, email click,
//      etc.). The server's heartbeat poller hits the skill's status
//      endpoint with the stored Bearer key on a cadence and flips
//      claim_status from `pending_claim` → `claimed` once the upstream
//      reports the agent as claimed.
//
//   4. USE      — once claimed, the PM tick loop pulls the skill via
//      agents/pm/src/skill.ts and exposes it as a `call_skill_api` tool
//      to the LLM. The Bearer key is attached server-side; the LLM never
//      sees it.
//
// SECURITY notes:
//   - Register endpoint must resolve to a host inside the parsed
//     allowedHosts set. A malicious SKILL.md that tries to send the
//     register POST to attacker-controlled infra is refused.
//   - apiKey lives on the row, only ever appears in outbound headers
//     to allowedHosts, never returned in API responses.

import crypto from 'node:crypto';
import { db, type AgentRole, type Logger } from '@swarm/shared';

const REGISTER_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 10_000;
/** How often the background poller hits each skill's status endpoint. */
const HEARTBEAT_INTERVAL_MS = 60_000;

// =====================================================================
// Discovery
// =====================================================================

export interface SkillFrontmatter {
  name: string | null;
  version: string | null;
  description: string | null;
  homepage: string | null;
  /** Inline JSON `metadata: {…}` block when present (moltbook style). */
  metadata: Record<string, unknown> | null;
  /**
   * Optional explicit allowlist `allowed_hosts: [host1, host2]` (JSON
   * array form) in YAML frontmatter. When set, this is the AUTHORITATIVE
   * host allowlist for the skill — body-grep is ignored. Lets a skill
   * author opt out of the loose "any host mentioned in markdown is
   * trusted" default, which is exploitable when prose includes a passing
   * mention of an attacker-chosen domain.
   */
  allowedHosts: string[] | null;
}

export interface DiscoveredSkill {
  frontmatter: SkillFrontmatter;
  /** Hosts referenced anywhere in the body. Drives the LLM tool allowlist. */
  allowedHosts: string[];
  /** Best-guess base URL for the skill's API. */
  apiBase: string | null;
  /** First "POST <url>/(agents/)?register" the body mentions. */
  registerEndpoint: string | null;
  /** First "GET <url>/(agents/)?status|me" the body mentions. */
  statusEndpoint: string | null;
}

/**
 * Pull metadata out of a SKILL.md without using a YAML library — the
 * frontmatter we care about is shallow scalars plus an optional inline
 * JSON `metadata: {…}` line. Anything fancier we silently ignore.
 */
export function parseFrontmatter(content: string): SkillFrontmatter {
  const empty: SkillFrontmatter = {
    name: null,
    version: null,
    description: null,
    homepage: null,
    metadata: null,
    allowedHosts: null,
  };
  const m = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return empty;
  const out: SkillFrontmatter = { ...empty };
  for (const line of m[1].split(/\r?\n/)) {
    const scalar = line.match(/^(name|version|description|homepage)\s*:\s*(.+?)\s*$/);
    if (scalar) {
      let val = scalar[2];
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      out[scalar[1] as 'name' | 'version' | 'description' | 'homepage'] = val;
      continue;
    }
    const meta = line.match(/^metadata\s*:\s*(\{.+\})\s*$/);
    if (meta) {
      try {
        out.metadata = JSON.parse(meta[1]) as Record<string, unknown>;
      } catch {
        // Non-JSON metadata block — ignore. Skill still installs.
      }
      continue;
    }
    // allowed_hosts: ["a.com", "b.com"] — JSON array form only.
    const hosts = line.match(/^allowed_hosts\s*:\s*(\[.+\])\s*$/);
    if (hosts) {
      try {
        const arr = JSON.parse(hosts[1]) as unknown;
        if (Array.isArray(arr)) {
          out.allowedHosts = arr
            .filter((v): v is string => typeof v === 'string' && v.length > 0)
            .map((v) => v.toLowerCase());
        }
      } catch {
        // Malformed list — fall back to body-grep allowlist.
      }
    }
  }
  return out;
}

/** Distinct https hosts referenced anywhere in the markdown. */
export function extractHosts(content: string): string[] {
  const out = new Set<string>();
  const re = /https?:\/\/([a-zA-Z0-9.\-]+)(?::\d+)?(?:\/|\b)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const host = m[1].toLowerCase();
    if (host === 'example.com' || host === 'localhost') continue;
    out.add(host);
  }
  return [...out];
}

/**
 * Find the first URL in `content` matching one of the verb+suffix patterns.
 * Tolerant of trailing punctuation that often appears in markdown
 * (`POST https://x/y \`, `POST https://x/y)`).
 */
function findUrlByVerbAndSuffix(
  content: string,
  verb: 'POST' | 'GET' | 'PUT' | 'DELETE' | 'PATCH',
  suffixes: string[],
): string | null {
  const re = new RegExp(`\\b${verb}\\s+(https?:\\/\\/\\S+)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const url = m[1].replace(/[)"'`,;]+$/g, '');
    for (const suffix of suffixes) {
      if (url.endsWith(suffix)) return url;
    }
  }
  return null;
}

/** Pull api_base from metadata — checks top-level + one level of nesting. */
function findApiBaseFromMetadata(
  meta: Record<string, unknown> | null,
): string | null {
  if (!meta) return null;
  const top = (meta as { api_base?: unknown }).api_base;
  if (typeof top === 'string') return top;
  for (const v of Object.values(meta)) {
    if (v && typeof v === 'object') {
      const inner = (v as { api_base?: unknown }).api_base;
      if (typeof inner === 'string') return inner;
    }
  }
  return null;
}

export function discover(content: string): DiscoveredSkill {
  const frontmatter = parseFrontmatter(content);
  // Prefer explicit allowed_hosts: [...] frontmatter — tight, author-
  // controlled. Body-grep fallback is the legacy default but is
  // exploitable: a SKILL.md that mentions an attacker host *anywhere*
  // (in prose, in a comment, in a code block) silently expands the
  // outbound HTTP allowlist for the LLM tool loop and the Bearer-key
  // forwarding paths.
  const allowedHosts =
    frontmatter.allowedHosts && frontmatter.allowedHosts.length > 0
      ? frontmatter.allowedHosts
      : extractHosts(content);
  const apiBase = findApiBaseFromMetadata(frontmatter.metadata);
  const registerEndpoint = findUrlByVerbAndSuffix(content, 'POST', [
    '/agents/register',
    '/register',
  ]);
  const statusEndpoint = findUrlByVerbAndSuffix(content, 'GET', [
    '/agents/status',
    '/agents/me',
    '/status',
  ]);
  return { frontmatter, allowedHosts, apiBase, registerEndpoint, statusEndpoint };
}

// =====================================================================
// Self-register
// =====================================================================

/**
 * Identity the swarm presents when self-registering with a skill. Kept
 * in one place so the moltbook agent that PM owns is recognizable on
 * the upstream's dashboard ("DefiSwarm-PM" rather than a UUID).
 */
function buildAgentName(role: AgentRole): string {
  const base = process.env.SWARM_AGENT_NAME_PREFIX ?? 'DefiSwarm';
  return `${base}-${role.toUpperCase()}`;
}

function buildAgentDescription(role: AgentRole, skillDescription: string | null): string {
  const persona =
    role === 'pm'
      ? 'I rebalance multi-token portfolios on Uniswap. I post insights and engage with other DeFi agents.'
      : role === 'alm'
        ? 'I manage Uniswap v4 LP positions. I share strategy notes and learn from other LPs.'
        : role === 'router'
          ? 'I route swap intents through OTC matching and Uniswap. I trade notes with other routers.'
          : 'I execute trades through KeeperHub + Uniswap. I share execution learnings with other agents.';
  return skillDescription ? `${persona} (via ${skillDescription})` : persona;
}

export interface RegisterResult {
  ok: boolean;
  /** Set on success. */
  apiKey?: string;
  claimUrl?: string;
  verificationCode?: string;
  registeredName?: string;
  /** Set on failure. */
  status?: number;
  error?: string;
}

/**
 * POST `{name, description}` to the discovered register endpoint and
 * parse the response. Tolerant of common shape variants — moltbook
 * nests under `agent`, others put fields at the root.
 */
export async function selfRegister(args: {
  registerEndpoint: string;
  agentRole: AgentRole;
  skillDescription: string | null;
  allowedHosts: string[];
}): Promise<RegisterResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(args.registerEndpoint);
  } catch {
    return { ok: false, error: `register endpoint not a valid URL` };
  }
  const host = parsedUrl.hostname.toLowerCase();
  if (!args.allowedHosts.includes(host)) {
    return {
      ok: false,
      error: `register endpoint host ${host} not in skill allowlist [${args.allowedHosts.join(', ')}]`,
    };
  }

  const name = buildAgentName(args.agentRole);
  const description = buildAgentDescription(args.agentRole, args.skillDescription);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTER_TIMEOUT_MS);
  try {
    const res = await fetch(args.registerEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Non-JSON upstream — pass through as a raw error string.
    }
    if (!res.ok) {
      const errMsg =
        (typeof body.error === 'string' && body.error) ||
        (typeof body.message === 'string' && body.message) ||
        text.slice(0, 200);
      return { ok: false, status: res.status, error: errMsg };
    }
    // Common shapes: { agent: { api_key, claim_url, verification_code, ... } } (moltbook),
    // { api_key, claim_url, ... } (root), { agentId, asn } (SwarmProtocol-style — no key).
    const inner =
      body.agent && typeof body.agent === 'object'
        ? (body.agent as Record<string, unknown>)
        : body;
    const apiKey =
      (typeof inner.api_key === 'string' && inner.api_key) ||
      (typeof inner.apiKey === 'string' && inner.apiKey) ||
      undefined;
    const claimUrl =
      (typeof inner.claim_url === 'string' && inner.claim_url) ||
      (typeof inner.claimUrl === 'string' && inner.claimUrl) ||
      undefined;
    const verificationCode =
      (typeof inner.verification_code === 'string' && inner.verification_code) ||
      (typeof inner.verificationCode === 'string' && inner.verificationCode) ||
      undefined;
    if (!apiKey) {
      return {
        ok: false,
        status: res.status,
        error:
          'register response had no api_key — skill may use a different identity model (e.g. ed25519 sigs)',
      };
    }
    return {
      ok: true,
      apiKey,
      claimUrl: claimUrl || undefined,
      verificationCode: verificationCode || undefined,
      registeredName: name,
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.name === 'AbortError'
            ? `register timed out after ${REGISTER_TIMEOUT_MS}ms`
            : err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// =====================================================================
// Status / heartbeat
// =====================================================================

interface StatusCheckResult {
  ok: boolean;
  claimStatus?: string;
  error?: string;
}

/**
 * GET the skill's status endpoint with the stored Bearer key. We don't
 * pretend to understand every skill's claim semantics — we just look
 * for a top-level `status` string and trust the skill's own taxonomy
 * (moltbook: `pending_claim` | `claimed`).
 */
async function checkStatus(skill: {
  statusEndpoint: string | null;
  apiKey: string | null;
  allowedHosts: string;
}): Promise<StatusCheckResult> {
  if (!skill.statusEndpoint || !skill.apiKey) {
    return { ok: false, error: 'no status endpoint or no api key' };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(skill.statusEndpoint);
  } catch {
    return { ok: false, error: 'status endpoint not a valid URL' };
  }
  const host = parsedUrl.hostname.toLowerCase();
  const allowed = skill.allowedHosts.split(',').filter(Boolean);
  if (!allowed.includes(host)) {
    return { ok: false, error: `status host ${host} not on allowlist` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const res = await fetch(skill.statusEndpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${skill.apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${text.slice(0, 200)}` };
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: true, claimStatus: 'claimed' }; // 200 with non-JSON body — treat as live
    }
    let status = 'unknown';
    if (typeof body.status === 'string') {
      status = body.status;
    } else if (body.agent && typeof body.agent === 'object') {
      const inner = (body.agent as { status?: unknown }).status;
      if (typeof inner === 'string') status = inner;
    } else if (typeof body.is_claimed === 'boolean') {
      status = body.is_claimed ? 'claimed' : 'pending_claim';
    }
    return { ok: true, claimStatus: status };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.name === 'AbortError'
            ? `status timed out after ${STATUS_TIMEOUT_MS}ms`
            : err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one heartbeat sweep — check status for every installed skill that
 * has a status endpoint + key. Best-effort; errors get logged but don't
 * propagate. Returns the number of rows updated for log spam control.
 */
export async function heartbeatSweep(log: Logger): Promise<number> {
  const skills = await db().skill.findMany({
    where: { apiKey: { not: null }, statusEndpoint: { not: null } },
  });
  let touched = 0;
  for (const s of skills) {
    const result = await checkStatus(s);
    if (result.ok) {
      await db().skill.update({
        where: { id: s.id },
        data: {
          claimStatus: result.claimStatus ?? 'unknown',
          lastHeartbeatAt: new Date(),
        },
      });
      touched++;
      if (result.claimStatus !== s.claimStatus) {
        log.info('skill claim status changed', {
          skillId: s.id,
          name: s.name,
          agentRole: s.agentRole,
          from: s.claimStatus,
          to: result.claimStatus,
        });
      }
    } else {
      log.warn('skill heartbeat failed', {
        skillId: s.id,
        name: s.name,
        err: result.error,
      });
    }
  }
  return touched;
}

/**
 * Start the heartbeat loop. Returns the timer handle so callers can
 * cancel during shutdown / tests.
 */
export function startHeartbeatLoop(log: Logger): NodeJS.Timeout {
  const tick = () => {
    heartbeatSweep(log).catch((err: unknown) => {
      log.error('heartbeat sweep crashed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  };
  // Fire once on boot so a fresh-installed skill flips to `claimed`
  // without waiting a full interval.
  setTimeout(tick, 5_000);
  return setInterval(tick, HEARTBEAT_INTERVAL_MS);
}

// =====================================================================
// Misc helpers
// =====================================================================

/** SHA-256 of the raw skill content. Used for drift detection. */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Last 4 chars of an api key for "••••abcd" UI surfaces. */
export function keyTail(k: string | null | undefined): string | null {
  return k && k.length >= 4 ? k.slice(-4) : null;
}
