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
app.use(express.json({ limit: '64kb' }));
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

app.listen(PORT, () => {
  log.info('api up', { port: PORT, allowedOrigins: ALLOWED_ORIGINS });
});
