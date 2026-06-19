// Tiny HTTP bridge between the Chrome extension and the agent backend.
//
// The extension's "Activate Swarm" flow grants a delegation policy
// onchain (EIP-7702) to each of the four agent service addresses, then
// POSTs here so the agents have a Session row to look up on their next
// tick.
//
// We deliberately keep this server thin: no auth headers (the extension
// is the user's browser, and the policy itself is enforced onchain — the
// DB row only tells the agents which wallets to act on, it doesn't grant
// any new authority). Real prod would still verify the txHash exists on
// the chain it claims, but for hackathon scope we trust the caller.

import cors from 'cors';
import express from 'express';

import {
  db,
  createLogger,
  type AgentRole,
} from '@swarm/shared';

const log = createLogger('api');

const PORT = Number(process.env.API_PORT ?? 8787);
const ALLOWED_ORIGINS = (process.env.API_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(
  cors({
    origin: (origin, cb) => {
      // Extensions send chrome-extension://<id>; same-origin server fetches
      // (e.g. from a future web dashboard) need an explicit allowlist via
      // API_ALLOWED_ORIGINS. No origin header → allow (Node test scripts).
      if (!origin) return cb(null, true);
      if (origin.startsWith('chrome-extension://')) return cb(null, true);
      if (origin.startsWith('moz-extension://')) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      if (ALLOWED_ORIGINS.includes('*')) return cb(null, true);
      cb(new Error(`Origin not allowed: ${origin}`));
    },
  }),
);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

interface SessionPostBody {
  walletAddress: string;
  /** Legacy alias — older extension builds still send this. */
  safeAddress?: string;
  ownerEoa: string;
  agent: AgentRole;
  sessionAddress: string;
  policyHash: string;
  /** Unix seconds. */
  validUntil: number;
  /** Comma-joined chains string ("base,unichain"). Optional — defaults to current. */
  chains?: string;
  /** Tx hash that mined the grant — for audit logging only. */
  txHash?: string;
}

const VALID_AGENTS: AgentRole[] = ['pm', 'alm', 'router', 'executor'];

app.post('/api/sessions', async (req, res) => {
  try {
    const body = req.body as Partial<SessionPostBody>;
    // Accept both new (walletAddress) and legacy (safeAddress) for
    // backwards compat with older extension builds that haven't picked
    // up the rename yet.
    const incomingWallet = body.walletAddress ?? body.safeAddress;
    if (
      !incomingWallet ||
      !body.ownerEoa ||
      !body.agent ||
      !body.sessionAddress ||
      !body.policyHash ||
      typeof body.validUntil !== 'number'
    ) {
      return res.status(400).json({
        error:
          'walletAddress, ownerEoa, agent, sessionAddress, policyHash, validUntil are required',
      });
    }
    if (!VALID_AGENTS.includes(body.agent)) {
      return res.status(400).json({ error: `agent must be one of ${VALID_AGENTS.join(',')}` });
    }

    const walletAddress = incomingWallet.toLowerCase();
    const ownerEoa = body.ownerEoa.toLowerCase();
    const sessionAddress = body.sessionAddress.toLowerCase();
    const validUntil = new Date(body.validUntil * 1000);

    // Upsert the user (single row per wallet — chains can grow over time).
    await db().user.upsert({
      where: { walletAddress },
      update: {
        ownerEoa,
        ...(body.chains ? { chains: body.chains } : {}),
      },
      create: {
        walletAddress,
        ownerEoa,
        chains: body.chains ?? '',
      },
    });

    // Upsert the session row (one row per (walletAddress, agent)).
    const session = await db().session.upsert({
      where: { walletAddress_agent: { walletAddress, agent: body.agent } },
      update: {
        sessionAddress,
        policyHash: body.policyHash,
        validUntil,
      },
      create: {
        walletAddress,
        agent: body.agent,
        sessionAddress,
        policyHash: body.policyHash,
        validUntil,
      },
    });

    // Audit row — useful for the dashboard timeline later.
    await db().event.create({
      data: {
        walletAddress,
        agent: body.agent,
        kind: 'session.granted',
        payload: {
          sessionAddress,
          policyHash: body.policyHash,
          validUntil: body.validUntil,
          txHash: body.txHash ?? null,
        },
      },
    });

    log.info('session registered', {
      walletAddress,
      agent: body.agent,
      sessionAddress,
      validUntil,
    });

    return res.status(201).json({ ok: true, sessionId: session.id });
  } catch (err) {
    log.error('register session failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

const VALID_PROFILES = ['conservative', 'balanced', 'aggressive', 'degen'];

app.put('/api/users/:walletAddress/profile', async (req, res) => {
  try {
    const walletAddress = req.params.walletAddress.toLowerCase();
    const { riskProfile, resetCustom } = req.body as {
      riskProfile?: string;
      resetCustom?: boolean;
    };
    if (!riskProfile || !VALID_PROFILES.includes(riskProfile)) {
      return res
        .status(400)
        .json({ error: `riskProfile must be one of ${VALID_PROFILES.join(',')}` });
    }
    const user = await db().user.update({
      where: { walletAddress },
      data: {
        riskProfile,
        ...(resetCustom ? { customConfig: null as unknown as object } : {}),
      },
    });
    log.info('risk profile updated', {
      walletAddress,
      riskProfile,
      resetCustom: !!resetCustom,
    });
    return res.json({ ok: true, riskProfile: user.riskProfile });
  } catch (err) {
    log.error('update profile failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

const KNOB_BOUNDS: Record<
  string,
  { min: number; max: number; type: 'frac' | 'bps' | 'min' }
> = {
  stableFloor: { min: 0, max: 1, type: 'frac' },
  maxToken: { min: 0.1, max: 1, type: 'frac' },
  maxShiftPerTick: { min: 0.01, max: 1, type: 'frac' },
  toleranceBps: { min: 10, max: 5000, type: 'bps' },
  cadenceMinutes: { min: 1, max: 1440, type: 'min' },
};

app.put('/api/users/:walletAddress/config', async (req, res) => {
  try {
    const walletAddress = req.params.walletAddress.toLowerCase();
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Merge incoming knobs into the existing customConfig, validating
    // each one against its allowed range.
    const existing =
      ((await db().user.findUnique({ where: { walletAddress } }))
        ?.customConfig as Record<string, unknown> | null) ?? {};
    const merged: Record<string, number> = {
      ...(existing as Record<string, number>),
    };
    for (const [k, v] of Object.entries(body)) {
      const bounds = KNOB_BOUNDS[k];
      if (!bounds) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < bounds.min || n > bounds.max) {
        return res.status(400).json({
          error: `${k} must be between ${bounds.min} and ${bounds.max}`,
        });
      }
      merged[k] = n;
    }

    const user = await db().user.update({
      where: { walletAddress },
      data: { customConfig: merged as unknown as object },
    });

    log.info('custom config updated', { walletAddress, knobs: Object.keys(body) });
    return res.json({ ok: true, customConfig: user.customConfig });
  } catch (err) {
    log.error('update config failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/sessions/:walletAddress', async (req, res) => {
  try {
    const walletAddress = req.params.walletAddress.toLowerCase();
    const sessions = await db().session.findMany({
      where: { walletAddress },
      orderBy: { grantedAt: 'desc' },
    });
    return res.json({ sessions });
  } catch (err) {
    log.error('list sessions failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

const GLOBAL_HEARTBEAT_KEY = '0x0000000000000000000000000000000000000000';

/**
 * Combined dashboard status query. Returns:
 *   - activated: does this wallet have a Session row?
 *   - agents: per-agent { lastSeen, status: 'online'|'idle'|'offline', users }
 *   - intents: most recent N intents for this wallet
 */
// Whitelist of chain values we'll surface to the dashboard when
// USE_TESTNET=true. Anything else (mainnet/base/unichain) gets
// filtered out client-side regardless of what's in the DB. PM
// allocations have no chain field — those always pass through.
const TESTNET_CHAINS = new Set(['sepolia', 'base-sepolia']);
const USE_TESTNET =
  (process.env.USE_TESTNET ?? 'false').toLowerCase() === 'true' ||
  process.env.USE_TESTNET === '1';

app.get('/api/status/:walletAddress', async (req, res) => {
  try {
    const walletAddress = req.params.walletAddress.toLowerCase();
    const now = Date.now();

    const [sessions, hbRows, intents, txEvents] = await Promise.all([
      db().session.findMany({
        where: { walletAddress, validUntil: { gt: new Date() } },
      }),
      db().agentState.findMany({
        where: { walletAddress: GLOBAL_HEARTBEAT_KEY },
      }),
      db().intent.findMany({
        where: { walletAddress },
        orderBy: { createdAt: 'desc' },
        // Pull more than we'll show because we may filter some out
        // post-fetch when USE_TESTNET=true.
        take: 80,
      }),
      // Recent execution events — used to attach a txHash to each
      // 'executed' routed intent so the dashboard can render a
      // clickable Etherscan link.
      db().event.findMany({
        where: { walletAddress, kind: { in: ['intent.executed', 'intent.failed'] } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);

    // intentId → { txHash, kind } map for fast lookup
    const eventByIntent = new Map<string, { txHash?: string; kind: string }>();
    for (const e of txEvents) {
      const p = (e.payload ?? {}) as { intentId?: string; txHash?: string };
      if (!p.intentId) continue;
      if (!eventByIntent.has(p.intentId)) {
        eventByIntent.set(p.intentId, { txHash: p.txHash, kind: e.kind });
      }
    }

    const agents = ['pm', 'alm', 'router', 'executor'].map((role) => {
      const row = hbRows.find((r) => r.agent === role);
      const state = (row?.state ?? {}) as { ts?: number; users?: number };
      const ts = typeof state.ts === 'number' ? state.ts : 0;
      const ageMs = now - ts;
      let status: 'online' | 'idle' | 'offline';
      if (ts === 0) status = 'offline';
      else if (ageMs < 30_000) status = 'online';
      else if (ageMs < 5 * 60_000) status = 'idle';
      else status = 'offline';
      return {
        role,
        status,
        lastSeenMs: ts,
        users: state.users ?? 0,
      };
    });

    const userRow = await db().user.findUnique({ where: { walletAddress } });

    return res.json({
      walletAddress,
      activated: sessions.length > 0,
      riskProfile: userRow?.riskProfile ?? 'balanced',
      customConfig: userRow?.customConfig ?? null,
      sessions: sessions.map((s) => ({
        agent: s.agent,
        sessionAddress: s.sessionAddress,
        validUntil: s.validUntil,
      })),
      agents,
      intents: intents
        // Hard-filter: when USE_TESTNET=true, hide every Router intent
        // whose payload chain isn't a testnet chain. Catches stale rows
        // from a previous mainnet config that the cleanup script missed,
        // and any new mainnet row that somehow squeaks past the dispatch
        // guards. PM rows (no chain field) always pass through.
        .filter((i) => {
          if (!USE_TESTNET) return true;
          if (i.fromAgent !== 'router') return true;
          const chain = (i.payload as { chain?: string } | null)?.chain;
          if (!chain) return true; // no chain field, can't filter
          return TESTNET_CHAINS.has(chain);
        })
        .slice(0, 25)
        .map((i) => {
        const ev = eventByIntent.get(i.id);
        // Truth-in-status: if the intent row claims `executed` but no
        // matching `intent.executed` event with a real txHash exists,
        // the swap didn't actually land onchain (race on KH responses,
        // crash mid-write, partial replay, etc). Surface it as `failed`
        // so the dashboard never lies. The DB row is left untouched —
        // we just present a more honest view.
        const hasRealTx =
          typeof ev?.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(ev.txHash);
        const isPmAlloc = i.fromAgent === 'pm';
        const surfacedStatus =
          i.status === 'executed' && !hasRealTx && !isPmAlloc
            ? 'failed'
            : i.status;
        return {
          id: i.id,
          fromAgent: i.fromAgent,
          status: surfacedStatus,
          payload: i.payload,
          createdAt: i.createdAt,
          // Surfaced on the row so the dashboard can render a clickable
          // Etherscan link beside any 'executed' routed intent.
          txHash: hasRealTx ? ev!.txHash : undefined,
        };
      }),
    });
  } catch (err) {
    log.error('status query failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

// =====================================================================
// Skill connector
// =====================================================================
// Skill connector
// =====================================================================
//
// A "skill" is a markdown file (Hermes-Agent style) that describes how
// to interact with some external service — see e.g. Moltbook's SKILL.md
// at https://www.moltbook.com/skill.md. The user pastes the skill into
// the extension, then pastes the API key for whatever service the skill
// targets. The swarm just persists both. Whether the skill is then
// driven by the user's Hermes (running elsewhere) or by a future swarm-
// side worker is downstream — this layer is storage only.
//
// Three endpoints:
//   GET    /api/skill        — current install (skill metadata + keyTail).
//                              Never echoes the full content+key.
//   PUT    /api/skill        — patch: { content?, apiKey?, clearKey? }
//                              On content paste we parse the YAML
//                              frontmatter and pull out name / version /
//                              description so the UI can show "installed:
//                              moltbook v1.12.0" without re-parsing.
//   DELETE /api/skill        — wipe everything (skill + key).

const keyTail = (k: string | null | undefined): string | null =>
  k && k.length >= 4 ? k.slice(-4) : null;

interface SkillFrontmatter {
  name: string | null;
  version: string | null;
  description: string | null;
}

/**
 * Parse the YAML-ish frontmatter from a Hermes skill file. We don't pull
 * a YAML lib for this — frontmatter blocks are simple key:value lines and
 * the only nested thing in the wild (Moltbook's `metadata: {…}` JSON) we
 * skip. If parsing fails we just return all-nulls; the swarm still stores
 * the raw content.
 */
function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const empty: SkillFrontmatter = { name: null, version: null, description: null };
  const m = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return empty;
  const block = m[1];
  const out: SkillFrontmatter = { ...empty };
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^(name|version|description)\s*:\s*(.+?)\s*$/);
    if (!kv) continue;
    const key = kv[1] as keyof SkillFrontmatter;
    let val = kv[2];
    // Strip surrounding quotes if present.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Pull the set of distinct https hosts referenced in the skill markdown.
 * The PM uses this list as the allowlist when the model invokes
 * `call_skill_api` — the API server surfaces it for the UI so users can
 * see which hosts their skill is actually allowed to talk to. Logic
 * mirrors agents/pm/src/skill.ts:extractHosts; kept duplicated to keep
 * `@swarm/shared` free of skill-runtime concerns.
 */
function extractSkillHosts(content: string | null | undefined): string[] {
  if (!content) return [];
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
 * Snapshot of the LLM provider currently selected for PM ticks. The skill
 * connector only drives the PM when provider==='hermes' AND a skill is
 * installed AND the skill exposes at least one callable host — so the UI
 * needs all three pieces to render the right status.
 */
function llmStatus(): {
  provider: 'groq' | 'hermes';
  hermesConfigured: boolean;
  hermesModel: string | null;
  hermesBaseUrl: string | null;
} {
  const provider = (process.env.LLM_PROVIDER ?? 'groq').toLowerCase() === 'hermes'
    ? 'hermes'
    : 'groq';
  const hermesConfigured = !!process.env.HERMES_API_KEY;
  return {
    provider,
    hermesConfigured,
    hermesModel: process.env.HERMES_MODEL ?? 'Hermes-4-405B',
    hermesBaseUrl:
      process.env.HERMES_BASE_URL ?? 'https://inference-api.nousresearch.com/v1',
  };
}

/**
 * Build the wire shape returned by GET/PUT /api/skill. Centralized so the
 * PUT response and the GET response stay in lock-step (they both feed the
 * same React Query cache key).
 */
function buildSkillState(row: {
  skillContent: string | null;
  skillApiKey: string | null;
  skillName: string | null;
  skillVersion: string | null;
  skillDescription: string | null;
  skillInstalledAt: Date | null;
  updatedAt: Date;
} | null) {
  const allowedHosts = extractSkillHosts(row?.skillContent);
  const llm = llmStatus();
  // The PM only injects the skill when Hermes is selected, content is
  // present, the key is present, and the skill listed at least one host.
  const pmActive =
    llm.provider === 'hermes' &&
    !!row?.skillContent &&
    !!row?.skillApiKey &&
    allowedHosts.length > 0;
  return {
    hasSkill: !!row?.skillContent,
    hasKey: !!row?.skillApiKey,
    keyTail: keyTail(row?.skillApiKey),
    name: row?.skillName ?? null,
    version: row?.skillVersion ?? null,
    description: row?.skillDescription ?? null,
    // Length only — don't ship the full markdown back on every poll.
    contentLength: row?.skillContent?.length ?? 0,
    installedAt: row?.skillInstalledAt ?? null,
    updatedAt: row?.updatedAt ?? null,
    allowedHosts,
    llmProvider: llm.provider,
    hermesConfigured: llm.hermesConfigured,
    hermesModel: llm.hermesModel,
    hermesBaseUrl: llm.hermesBaseUrl,
    pmActive,
  };
}

app.get('/api/skill', async (_req, res) => {
  try {
    const row = await db().swarmSettings.findUnique({ where: { id: 'global' } });
    return res.json(buildSkillState(row));
  } catch (err) {
    log.error('get skill failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

interface SkillPutBody {
  /** Paste the full skill markdown. `null` to clear, omitted to leave alone. */
  content?: string | null;
  /** Paste the API key. `null` (or `clearKey:true`) to clear. */
  apiKey?: string | null;
  clearKey?: boolean;
}

app.put('/api/skill', async (req, res) => {
  try {
    const body = (req.body ?? {}) as SkillPutBody;
    const existing =
      (await db().swarmSettings.findUnique({ where: { id: 'global' } })) ?? null;

    // Resolve the new content + frontmatter. `undefined` = leave alone,
    // `null` = clear, string = overwrite + reparse.
    let nextContent: string | null;
    let nextFm: SkillFrontmatter;
    if (body.content === null) {
      nextContent = null;
      nextFm = { name: null, version: null, description: null };
    } else if (typeof body.content === 'string') {
      if (body.content.length > 200_000) {
        return res.status(413).json({ error: 'skill content > 200KB rejected' });
      }
      nextContent = body.content;
      nextFm = parseSkillFrontmatter(body.content);
    } else {
      nextContent = existing?.skillContent ?? null;
      nextFm = {
        name: existing?.skillName ?? null,
        version: existing?.skillVersion ?? null,
        description: existing?.skillDescription ?? null,
      };
    }

    const isClearingKey = body.clearKey === true || body.apiKey === null;
    const nextKey =
      isClearingKey
        ? null
        : typeof body.apiKey === 'string' && body.apiKey.length > 0
          ? body.apiKey
          : (existing?.skillApiKey ?? null);

    // First-install timestamp: stamp once when the row goes from "no
    // skill" to "skill present", and clear when content is cleared.
    const wasInstalled = !!existing?.skillContent;
    const willBeInstalled = !!nextContent;
    const nextInstalledAt = willBeInstalled
      ? wasInstalled
        ? (existing?.skillInstalledAt ?? new Date())
        : new Date()
      : null;

    const next = {
      skillContent: nextContent,
      skillName: nextFm.name,
      skillVersion: nextFm.version,
      skillDescription: nextFm.description,
      skillApiKey: nextKey,
      skillInstalledAt: nextInstalledAt,
    };

    const saved = await db().swarmSettings.upsert({
      where: { id: 'global' },
      update: next,
      create: { id: 'global', ...next },
    });

    log.info('skill updated', {
      name: saved.skillName,
      version: saved.skillVersion,
      hasKey: !!saved.skillApiKey,
      keyTail: keyTail(saved.skillApiKey),
      contentLength: saved.skillContent?.length ?? 0,
      allowedHosts: extractSkillHosts(saved.skillContent),
    });

    return res.json(buildSkillState(saved));
  } catch (err) {
    log.error('update skill failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/skill', async (_req, res) => {
  try {
    await db().swarmSettings.update({
      where: { id: 'global' },
      data: {
        skillContent: null,
        skillName: null,
        skillVersion: null,
        skillDescription: null,
        skillApiKey: null,
        skillInstalledAt: null,
      },
    });
    return res.json({ hasSkill: false, hasKey: false });
  } catch (err) {
    log.error('delete skill failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

// =====================================================================
// Hermes connection test
// =====================================================================
//
// Smoke-tests the configured Hermes endpoint with a one-token chat
// completion. The UI calls this from the connector card after a user
// pastes their key/configures env so they get instant "yes, your Hermes
// is reachable" feedback instead of waiting for the next PM tick to
// blow up.
//
// Why a custom fetch instead of the OpenAI SDK? Keeps agents/api free
// of an SDK dep just to issue one HTTP POST — the request body is OAI-
// compatible and tiny. We propagate the upstream status code and the
// first line of the error so the UI can surface "401: invalid api key"
// or "404: model not found" without us guessing.

const HERMES_TEST_TIMEOUT_MS = 10_000;

app.post('/api/hermes/test', async (_req, res) => {
  const apiKey = process.env.HERMES_API_KEY ?? '';
  const baseUrl =
    process.env.HERMES_BASE_URL ?? 'https://inference-api.nousresearch.com/v1';
  const model = process.env.HERMES_MODEL ?? 'Hermes-4-405B';

  if (!apiKey) {
    return res.status(400).json({
      ok: false,
      error: 'HERMES_API_KEY not set on the agents server',
      hint: 'set HERMES_API_KEY in agents/.env and restart the API',
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HERMES_TEST_TIMEOUT_MS);
  const started = Date.now();
  try {
    const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: 8,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: 'Reply with the single word: ok',
          },
        ],
      }),
    });

    const latencyMs = Date.now() - started;
    const text = await upstream.text();
    let parsed: { choices?: Array<{ message?: { content?: string } }> } | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON upstream response — pass the first 200 chars through.
    }
    if (!upstream.ok) {
      return res.status(502).json({
        ok: false,
        status: upstream.status,
        latencyMs,
        model,
        baseUrl,
        error: text.slice(0, 200),
      });
    }
    const sample = parsed?.choices?.[0]?.message?.content?.trim() ?? null;
    return res.json({
      ok: true,
      status: upstream.status,
      latencyMs,
      model,
      baseUrl,
      sample,
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      latencyMs: Date.now() - started,
      model,
      baseUrl,
      error:
        err instanceof Error
          ? err.name === 'AbortError'
            ? `timed out after ${HERMES_TEST_TIMEOUT_MS}ms`
            : err.message
          : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
});


// =====================================================================
// Internal endpoints — called by KeeperHub scheduled workflows
// =====================================================================
//
// Auth: shared secret in `x-internal-key` header. Set SWARM_INTERNAL_KEY
// in agents/.env and reference the same value in the KH workflow JSON.
// Falls open when the env var is unset (dev mode) so contributors can
// poke endpoints without ceremony.

const INTERNAL_KEY = process.env.SWARM_INTERNAL_KEY ?? '';

function requireInternal(
  req: express.Request,
  res: express.Response,
): boolean {
  if (!INTERNAL_KEY) return true; // dev mode, fail open
  if (req.header('x-internal-key') === INTERNAL_KEY) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

/** PM tick — called by `swarm.scheduled-tick` every 5 min and by
 *  `swarm.risk-change-apply` on profile change. Body may include a
 *  `walletAddress` to scope to one user; otherwise ticks all active
 *  sessions. The actual tick happens inside the PM process —
 *  this endpoint just emits an Event row that PM polls. */
app.post('/internal/tick', async (req, res) => {
  if (!requireInternal(req, res)) return;
  const body = (req.body ?? {}) as {
    source?: string;
    walletAddress?: string;
  };
  try {
    await db().event.create({
      data: {
        // Per-wallet tick request → row keyed to that wallet. Global
        // tick request (no wallet) → keyed to a synthetic system row
        // so PM's poller picks it up regardless.
        walletAddress: body.walletAddress ?? '0x0000000000000000000000000000000000000000',
        agent: 'pm',
        kind: 'kh.tick-request',
        payload: {
          source: body.source ?? 'kh',
          requestedAt: new Date().toISOString(),
        },
      },
    });
    return res.json({ ok: true });
  } catch (err) {
    log.error('internal tick failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'tick failed' });
  }
});

/** ALM position scan — called by `swarm.alm-position-check` every 15 min. */
app.post('/internal/alm/scan-positions', async (req, res) => {
  if (!requireInternal(req, res)) return;
  try {
    await db().event.create({
      data: {
        walletAddress: '0x0000000000000000000000000000000000000000',
        agent: 'alm',
        kind: 'kh.scan-request',
        payload: { source: 'kh.alm-position-check' },
      },
    });
    return res.json({ ok: true });
  } catch (err) {
    log.error('internal alm scan failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'scan failed' });
  }
});

/** Daily report — called by `swarm.treasury-report` at 00:00 UTC.
 *  Returns the digest as JSON; the workflow's next step posts it to
 *  the user's configured delivery webhook (Telegram, email). */
app.post('/internal/report/daily', async (req, res) => {
  if (!requireInternal(req, res)) return;
  const body = (req.body ?? {}) as { windowHours?: number };
  const windowHours = body.windowHours ?? 24;
  const cutoff = new Date(Date.now() - windowHours * 3600 * 1000);

  try {
    const intents = await db().intent.findMany({
      where: { createdAt: { gte: cutoff } },
      select: {
        walletAddress: true,
        fromAgent: true,
        status: true,
        payload: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    // Aggregate per-wallet stats so the report has a per-user section.
    const byWallet = new Map<
      string,
      {
        totalIntents: number;
        executed: number;
        failed: number;
        otcMatched: number;
        otcSavedUsd: number;
        notionalUsd: number;
      }
    >();
    for (const i of intents) {
      const key = i.walletAddress;
      const cur = byWallet.get(key) ?? {
        totalIntents: 0,
        executed: 0,
        failed: 0,
        otcMatched: 0,
        otcSavedUsd: 0,
        notionalUsd: 0,
      };
      cur.totalIntents += 1;
      if (i.status === 'executed') cur.executed += 1;
      if (i.status === 'failed') cur.failed += 1;
      const p = (i.payload as Record<string, unknown> | null) ?? {};
      if (p.venue === 'otc-mesh') {
        cur.otcMatched += 1;
        const otc = p.otc as { savedUsd?: number } | undefined;
        cur.otcSavedUsd += otc?.savedUsd ?? 0;
      }
      if (typeof p.notionalUsd === 'number') {
        cur.notionalUsd += p.notionalUsd;
      }
      byWallet.set(key, cur);
    }

    return res.json({
      ok: true,
      windowHours,
      generatedAt: new Date().toISOString(),
      totals: {
        intents: intents.length,
        wallets: byWallet.size,
      },
      perWallet: Array.from(byWallet.entries()).map(([wallet, stats]) => ({
        walletAddress: wallet,
        ...stats,
      })),
    });
  } catch (err) {
    log.error('internal daily report failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'report failed' });
  }
});

app.listen(PORT, () => {
  log.info('api up', { port: PORT, allowedOrigins: ALLOWED_ORIGINS });
});
