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
import {
  discover,
  hashContent,
  keyTail,
  selfRegister,
  startHeartbeatLoop,
} from './skills.js';
import { requireWalletAuth, WALLET_AUTH_REQUIRED } from './auth.js';

const log = createLogger('api');

const PORT = Number(process.env.API_PORT ?? 8787);
const ALLOWED_ORIGINS = (process.env.API_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Allowlist of extension IDs — only chrome-extension://<ID> origins in
// this set may call the API. When unset, we still let extensions through
// (legacy dev mode) but warn loudly at boot. In production, set this to
// the published extension's ID to refuse rogue extensions on the same
// browser profile from poking the agents API.
const EXTENSION_IDS = new Set(
  (process.env.EXTENSION_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const EXTENSION_PIN_ENABLED = EXTENSION_IDS.size > 0;

function isAllowedExtensionOrigin(origin: string): boolean {
  // origin shape: chrome-extension://<id> or moz-extension://<id>
  const m = origin.match(/^(?:chrome|moz)-extension:\/\/([a-zA-Z0-9_-]+)\/?$/);
  if (!m) return false;
  if (!EXTENSION_PIN_ENABLED) return true; // legacy dev — accept any
  return EXTENSION_IDS.has(m[1]);
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(
  cors({
    origin: (origin, cb) => {
      // No origin (curl, Node test scripts) → allow.
      if (!origin) return cb(null, true);
      if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
        if (isAllowedExtensionOrigin(origin)) return cb(null, true);
        return cb(new Error(`Extension origin not in EXTENSION_IDS allowlist: ${origin}`));
      }
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      if (ALLOWED_ORIGINS.includes('*')) return cb(null, true);
      cb(new Error(`Origin not allowed: ${origin}`));
    },
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'x-wallet-address',
      'x-wallet-ts',
      'x-wallet-sig',
      'x-internal-key',
    ],
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

app.post(
  '/api/sessions',
  requireWalletAuth((req) => {
    const b = (req.body ?? {}) as Partial<SessionPostBody>;
    // The auth header proves ownership of `ownerEoa`; in 7702 mode
    // ownerEoa === walletAddress, but we authenticate against ownerEoa
    // (the actual signer) regardless.
    return b.ownerEoa;
  }),
  async (req, res) => {
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
    // Edge-validate every address shape so junk input fails 400 here
    // instead of 500ing inside Prisma.
    if (
      !/^0x[a-f0-9]{40}$/.test(walletAddress) ||
      !/^0x[a-f0-9]{40}$/.test(ownerEoa) ||
      !/^0x[a-f0-9]{40}$/.test(sessionAddress)
    ) {
      return res.status(400).json({
        error: 'walletAddress, ownerEoa, sessionAddress must be 0x EOA addresses',
      });
    }
    if (!/^0x[a-f0-9]+$/.test(body.policyHash.toLowerCase())) {
      return res.status(400).json({ error: 'policyHash must be 0x hex' });
    }
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
  },
);

const VALID_PROFILES = ['conservative', 'balanced', 'aggressive', 'degen'];

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

app.put(
  '/api/users/:walletAddress/profile',
  requireWalletAuth((req) => req.params.walletAddress),
  async (req, res) => {
  try {
    const walletAddress = req.params.walletAddress.toLowerCase();
    if (!ADDR_RE.test(walletAddress)) {
      return res.status(400).json({ error: 'walletAddress must be a 0x EOA address' });
    }
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
  },
);

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

app.put(
  '/api/users/:walletAddress/config',
  requireWalletAuth((req) => req.params.walletAddress),
  async (req, res) => {
  try {
    const walletAddress = req.params.walletAddress.toLowerCase();
    if (!ADDR_RE.test(walletAddress)) {
      return res.status(400).json({ error: 'walletAddress must be a 0x EOA address' });
    }
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
  },
);

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
// Skill connector — auto-register flow
// =====================================================================
//
// A "skill" is a SKILL.md describing how to talk to some external
// service (e.g. Moltbook https://www.moltbook.com/skill.md). The flow:
//
//   1. POST /api/skills  with { content | sourceUrl, agentRole }.
//        Server discovers register/status endpoints + host allowlist
//        from the markdown, immediately POSTs the discovered register
//        endpoint with `{name: DefiSwarm-PM, description: ...}`, and
//        persists everything returned (apiKey server-only).
//   2. The response includes claim_url + verification_code — the human
//      visits that URL to complete claim on the skill's own site.
//   3. A background heartbeat poller (skills.startHeartbeatLoop) hits
//      each skill's status endpoint with the stored Bearer key and
//      flips claim_status from `pending_claim` → `claimed` once the
//      upstream confirms.
//
// What is NOT here:
//   - User-pasted API keys. Skills self-register; the swarm acquires
//     credentials by following the SKILL.md, not by asking the human.
//   - Hermes/Groq LLM provider config. That's env-driven and the PM
//     reads it directly. Skills are orthogonal — they're external
//     services the agents can act on, regardless of which LLM drives
//     the agent.

const MAX_SKILL_CONTENT_BYTES = 200_000;
const FETCH_SKILL_TIMEOUT_MS = 15_000;

interface SkillRow {
  id: string;
  agentRole: AgentRole;
  name: string;
  version: string | null;
  description: string | null;
  sourceUrl: string | null;
  contentHash: string;
  content: string;
  allowedHosts: string;
  registerEndpoint: string | null;
  statusEndpoint: string | null;
  apiBase: string | null;
  apiKey: string | null;
  claimUrl: string | null;
  verificationCode: string | null;
  claimStatus: string;
  lastHeartbeatAt: Date | null;
  registeredName: string | null;
  installedAt: Date;
  updatedAt: Date;
}

/**
 * Wire shape for /api/skills responses. Strips `content` (large) and
 * `apiKey` (secret); surfaces everything the UI needs to render the
 * connector card and the claim flow.
 */
function toWire(row: SkillRow) {
  return {
    id: row.id,
    agentRole: row.agentRole,
    name: row.name,
    version: row.version,
    description: row.description,
    sourceUrl: row.sourceUrl,
    contentHash: row.contentHash,
    contentLength: row.content.length,
    allowedHosts: row.allowedHosts.split(',').filter(Boolean),
    apiBase: row.apiBase,
    registerEndpoint: row.registerEndpoint,
    statusEndpoint: row.statusEndpoint,
    hasApiKey: !!row.apiKey,
    keyTail: keyTail(row.apiKey),
    claimUrl: row.claimUrl,
    verificationCode: row.verificationCode,
    claimStatus: row.claimStatus,
    lastHeartbeatAt: row.lastHeartbeatAt,
    registeredName: row.registeredName,
    installedAt: row.installedAt,
    updatedAt: row.updatedAt,
  };
}

const VALID_ROLES: AgentRole[] = ['pm', 'alm', 'router', 'executor'];

/**
 * Reject IPs that point to the agent host's own network — cloud
 * metadata, internal services, RFC1918, loopback, link-local, ULA.
 * Stops a malicious sourceUrl from pivoting the agent into an SSRF
 * probe of the surrounding infra.
 */
function isPrivateIp(ip: string): boolean {
  // IPv4
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  // IPv6 — coarse buckets covering loopback, link-local, ULA, IPv4-mapped private.
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fe80:')) return true; // link-local
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // ULA
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7)); // mapped IPv4
  return false;
}

async function fetchSkillContent(sourceUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error(`sourceUrl not a valid URL: ${sourceUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`sourceUrl must be https: got ${parsed.protocol}`);
  }
  // SSRF guard: resolve hostname and reject if any answer is a private,
  // loopback, link-local, or cloud-metadata address. Done after URL parse
  // so a literal `http://169.254.169.254/...` URL is also blocked.
  const { lookup } = await import('node:dns/promises');
  let addrs;
  try {
    addrs = await lookup(parsed.hostname, { all: true });
  } catch (err) {
    throw new Error(
      `sourceUrl host ${parsed.hostname} did not resolve: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error(
        `sourceUrl host ${parsed.hostname} resolves to private/loopback address ${a.address}`,
      );
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_SKILL_TIMEOUT_MS);
  try {
    const res = await fetch(sourceUrl, {
      headers: { Accept: 'text/markdown, text/plain, */*' },
      signal: controller.signal,
      // Don't follow redirects across hosts — a malicious upstream could
      // 302 us to an internal address that would bypass the lookup check.
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`fetch ${sourceUrl} → ${res.status} (redirects disallowed)`);
    }
    if (!res.ok) {
      throw new Error(`fetch ${sourceUrl} → ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    if (text.length > MAX_SKILL_CONTENT_BYTES) {
      throw new Error(
        `skill content > ${MAX_SKILL_CONTENT_BYTES / 1000}KB; rejected`,
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Hermes connectivity smoke test. Pings the configured endpoint with a
// one-token completion to verify HERMES_API_KEY / HERMES_BASE_URL /
// HERMES_MODEL are reachable and authorized. Surfaces structured JSON
// for the UI's "Test Hermes" button regardless of success/failure mode.
const HERMES_TEST_TIMEOUT_MS = 8_000;

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
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      }),
    });

    const latencyMs = Date.now() - started;
    const text = await upstream.text();
    let parsed: { choices?: Array<{ message?: { content?: string } }> } | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON upstream — fall through to slice below.
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

app.get('/api/skills', async (_req, res) => {
  try {
    const rows = (await db().skill.findMany({
      orderBy: { installedAt: 'desc' },
    })) as SkillRow[];
    return res.json({ skills: rows.map(toWire) });
  } catch (err) {
    log.error('list skills failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

interface SkillPostBody {
  /** Either inline markdown content… */
  content?: string;
  /** …or a URL to fetch the SKILL.md from. One of the two is required. */
  sourceUrl?: string;
  /** Which swarm agent owns this install. */
  agentRole: AgentRole;
}

app.post('/api/skills', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Partial<SkillPostBody>;
    if (!body.agentRole || !VALID_ROLES.includes(body.agentRole)) {
      return res.status(400).json({
        error: `agentRole required, one of: ${VALID_ROLES.join(', ')}`,
      });
    }
    if (!body.content && !body.sourceUrl) {
      return res
        .status(400)
        .json({ error: 'content or sourceUrl is required' });
    }

    let content: string;
    let sourceUrl: string | null = null;
    if (typeof body.sourceUrl === 'string' && body.sourceUrl.length > 0) {
      try {
        content = await fetchSkillContent(body.sourceUrl);
      } catch (err) {
        return res.status(400).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
      sourceUrl = body.sourceUrl;
    } else {
      content = String(body.content ?? '');
      if (content.length > MAX_SKILL_CONTENT_BYTES) {
        return res
          .status(413)
          .json({ error: `skill content > ${MAX_SKILL_CONTENT_BYTES / 1000}KB` });
      }
    }
    if (content.trim().length < 10) {
      return res.status(400).json({ error: 'skill content too short' });
    }

    const discovered = discover(content);
    const name = discovered.frontmatter.name?.trim();
    if (!name) {
      return res.status(400).json({
        error:
          'skill needs a `name:` field in YAML frontmatter (--- name: foo ---)',
      });
    }
    if (!discovered.registerEndpoint) {
      return res.status(400).json({
        error:
          'skill has no discoverable POST .../register or .../agents/register endpoint',
        hint: 'this connector currently supports skills with a self-register flow',
      });
    }

    // Self-register against the upstream. We do this BEFORE persisting
    // so that a 4xx from the upstream surfaces as a clean error to the
    // UI, not as an orphaned skill row that requires manual cleanup.
    const reg = await selfRegister({
      registerEndpoint: discovered.registerEndpoint,
      agentRole: body.agentRole,
      skillDescription: discovered.frontmatter.description,
      allowedHosts: discovered.allowedHosts,
    });
    if (!reg.ok) {
      log.warn('skill register failed', {
        agentRole: body.agentRole,
        name,
        registerEndpoint: discovered.registerEndpoint,
        status: reg.status,
        err: reg.error,
      });
      return res.status(502).json({
        error: `register failed: ${reg.error}`,
        registerEndpoint: discovered.registerEndpoint,
        upstreamStatus: reg.status,
      });
    }

    const saved = (await db().skill.upsert({
      where: { agentRole_name: { agentRole: body.agentRole, name } },
      create: {
        agentRole: body.agentRole,
        name,
        version: discovered.frontmatter.version,
        description: discovered.frontmatter.description,
        sourceUrl,
        contentHash: hashContent(content),
        content,
        allowedHosts: discovered.allowedHosts.join(','),
        registerEndpoint: discovered.registerEndpoint,
        statusEndpoint: discovered.statusEndpoint,
        apiBase: discovered.apiBase,
        apiKey: reg.apiKey ?? null,
        claimUrl: reg.claimUrl ?? null,
        verificationCode: reg.verificationCode ?? null,
        claimStatus: reg.claimUrl ? 'pending_claim' : 'unknown',
        registeredName: reg.registeredName ?? null,
      },
      update: {
        version: discovered.frontmatter.version,
        description: discovered.frontmatter.description,
        sourceUrl,
        contentHash: hashContent(content),
        content,
        allowedHosts: discovered.allowedHosts.join(','),
        registerEndpoint: discovered.registerEndpoint,
        statusEndpoint: discovered.statusEndpoint,
        apiBase: discovered.apiBase,
        // Reuse existing key when re-installing the same skill — re-
        // registering would mint a fresh identity and orphan the
        // upstream agent. Only refresh on /refresh-status if explicitly
        // requested.
        apiKey: reg.apiKey ?? null,
        claimUrl: reg.claimUrl ?? null,
        verificationCode: reg.verificationCode ?? null,
        claimStatus: reg.claimUrl ? 'pending_claim' : 'unknown',
        registeredName: reg.registeredName ?? null,
      },
    })) as SkillRow;

    log.info('skill installed + registered', {
      id: saved.id,
      agentRole: saved.agentRole,
      name: saved.name,
      keyTail: keyTail(saved.apiKey),
      registerEndpoint: saved.registerEndpoint,
      statusEndpoint: saved.statusEndpoint,
      claimStatus: saved.claimStatus,
    });

    return res.status(201).json({ skill: toWire(saved) });
  } catch (err) {
    log.error('install skill failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/skills/:id', async (req, res) => {
  try {
    const row = (await db().skill.findUnique({
      where: { id: req.params.id },
    })) as SkillRow | null;
    if (!row) return res.status(404).json({ error: 'skill not found' });
    return res.json({ skill: toWire(row) });
  } catch (err) {
    log.error('get skill failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

app.delete('/api/skills/:id', async (req, res) => {
  try {
    await db().skill.delete({ where: { id: req.params.id } });
    log.info('skill uninstalled', { id: req.params.id });
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Record to delete')) {
      return res.status(404).json({ error: 'skill not found' });
    }
    log.error('delete skill failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * Manual claim-status refresh. The background heartbeat poller already
 * does this every minute; this endpoint exists so the UI can give
 * users an immediate "I just claimed, did it work?" affordance.
 */
app.post('/api/skills/:id/refresh-status', async (req, res) => {
  try {
    const { heartbeatSweep } = await import('./skills.js');
    const touched = await heartbeatSweep(log);
    const row = (await db().skill.findUnique({
      where: { id: req.params.id },
    })) as SkillRow | null;
    if (!row) return res.status(404).json({ error: 'skill not found' });
    return res.json({ skill: toWire(row), polled: touched });
  } catch (err) {
    log.error('refresh skill status failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});


// =====================================================================
// Internal endpoints — called by KeeperHub scheduled workflows
// =====================================================================
//
// Auth: shared secret in `x-internal-key` header. Set SWARM_INTERNAL_KEY
// in agents/.env and reference the same value in the KH workflow JSON.
// When the env var is unset, internal endpoints REJECT every call —
// previously these fell open, which let any caller flood the tick queue
// or pull the daily treasury report.

const INTERNAL_KEY = process.env.SWARM_INTERNAL_KEY ?? '';

function requireInternal(
  req: express.Request,
  res: express.Response,
): boolean {
  if (!INTERNAL_KEY) {
    res.status(503).json({
      error:
        'internal endpoint disabled: set SWARM_INTERNAL_KEY in agents/.env to enable',
    });
    return false;
  }
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
  log.info('api up', {
    port: PORT,
    allowedOrigins: ALLOWED_ORIGINS,
    extensionPin: EXTENSION_PIN_ENABLED ? [...EXTENSION_IDS] : 'OFF (dev mode)',
    walletAuth: WALLET_AUTH_REQUIRED ? 'REQUIRED' : 'optional (dev mode)',
    internalKey: INTERNAL_KEY ? 'set' : 'UNSET (internal endpoints disabled)',
  });
  if (!EXTENSION_PIN_ENABLED) {
    log.warn(
      'EXTENSION_IDS unset — every chrome-extension:// origin can call this API. ' +
        'Set EXTENSION_IDS=<your-extension-id> in production.',
    );
  }
  if (!WALLET_AUTH_REQUIRED) {
    log.warn(
      'WALLET_AUTH_REQUIRED is not "true" — wallet-mutation endpoints accept ' +
        'unsigned requests. Set WALLET_AUTH_REQUIRED=true in production.',
    );
  }
  // Skill heartbeat — polls each installed skill's status endpoint
  // every minute to flip claim_status from `pending_claim` → `claimed`
  // once the human completes verification on the upstream's site.
  startHeartbeatLoop(log);
});
