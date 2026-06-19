// Tiny HTTP bridge between the Chrome extension and the agent backend.
//
// The extension's "Activate Swarm" flow grants a Smart Sessions policy
// onchain to each of the four agent service addresses, then POSTs here
// so the agents have a Session row to look up on their next tick.
//
// We deliberately keep this server thin: no auth headers (the extension
// is the user's browser, and the policy itself is enforced onchain — the
// DB row only tells the agents which Safes to act on, it doesn't grant
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
  safeAddress: string;
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
    if (
      !body.safeAddress ||
      !body.ownerEoa ||
      !body.agent ||
      !body.sessionAddress ||
      !body.policyHash ||
      typeof body.validUntil !== 'number'
    ) {
      return res.status(400).json({
        error:
          'safeAddress, ownerEoa, agent, sessionAddress, policyHash, validUntil are required',
      });
    }
    if (!VALID_AGENTS.includes(body.agent)) {
      return res.status(400).json({ error: `agent must be one of ${VALID_AGENTS.join(',')}` });
    }

    const safeAddress = body.safeAddress.toLowerCase();
    const ownerEoa = body.ownerEoa.toLowerCase();
    const sessionAddress = body.sessionAddress.toLowerCase();
    const validUntil = new Date(body.validUntil * 1000);

    // Upsert the user (single row per Safe — chains can grow over time).
    await db().user.upsert({
      where: { safeAddress },
      update: {
        ownerEoa,
        ...(body.chains ? { chains: body.chains } : {}),
      },
      create: {
        safeAddress,
        ownerEoa,
        chains: body.chains ?? '',
      },
    });

    // Upsert the session row (one row per (safeAddress, agent)).
    const session = await db().session.upsert({
      where: { safeAddress_agent: { safeAddress, agent: body.agent } },
      update: {
        sessionAddress,
        policyHash: body.policyHash,
        validUntil,
      },
      create: {
        safeAddress,
        agent: body.agent,
        sessionAddress,
        policyHash: body.policyHash,
        validUntil,
      },
    });

    // Audit row — useful for the dashboard timeline later.
    await db().event.create({
      data: {
        safeAddress,
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
      safeAddress,
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

app.put('/api/users/:safeAddress/profile', async (req, res) => {
  try {
    const safeAddress = req.params.safeAddress.toLowerCase();
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
      where: { safeAddress },
      data: {
        riskProfile,
        ...(resetCustom ? { customConfig: null as unknown as object } : {}),
      },
    });
    log.info('risk profile updated', {
      safeAddress,
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

app.put('/api/users/:safeAddress/config', async (req, res) => {
  try {
    const safeAddress = req.params.safeAddress.toLowerCase();
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Merge incoming knobs into the existing customConfig, validating
    // each one against its allowed range.
    const existing =
      ((await db().user.findUnique({ where: { safeAddress } }))
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
      where: { safeAddress },
      data: { customConfig: merged as unknown as object },
    });

    log.info('custom config updated', { safeAddress, knobs: Object.keys(body) });
    return res.json({ ok: true, customConfig: user.customConfig });
  } catch (err) {
    log.error('update config failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/sessions/:safeAddress', async (req, res) => {
  try {
    const safeAddress = req.params.safeAddress.toLowerCase();
    const sessions = await db().session.findMany({
      where: { safeAddress },
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
 *   - activated: does this safe have a Session row?
 *   - agents: per-agent { lastSeen, status: 'online'|'idle'|'offline', users }
 *   - intents: most recent N intents for this safe
 */
app.get('/api/status/:safeAddress', async (req, res) => {
  try {
    const safeAddress = req.params.safeAddress.toLowerCase();
    const now = Date.now();

    const [sessions, hbRows, intents] = await Promise.all([
      db().session.findMany({
        where: { safeAddress, validUntil: { gt: new Date() } },
      }),
      db().agentState.findMany({
        where: { safeAddress: GLOBAL_HEARTBEAT_KEY },
      }),
      db().intent.findMany({
        where: { safeAddress },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
    ]);

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

    const userRow = await db().user.findUnique({ where: { safeAddress } });

    return res.json({
      safeAddress,
      activated: sessions.length > 0,
      riskProfile: userRow?.riskProfile ?? 'balanced',
      customConfig: userRow?.customConfig ?? null,
      sessions: sessions.map((s) => ({
        agent: s.agent,
        sessionAddress: s.sessionAddress,
        validUntil: s.validUntil,
      })),
      agents,
      intents: intents.map((i) => ({
        id: i.id,
        fromAgent: i.fromAgent,
        status: i.status,
        payload: i.payload,
        createdAt: i.createdAt,
      })),
    });
  } catch (err) {
    log.error('status query failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * Hermes / LLM provider override.
 *
 * One global settings row — paste an API key + model + (optional) skill
 * text from the extension and PM picks it up on the next tick instead of
 * the env-var Groq defaults. We never echo the full API key back to the
 * UI; once it's saved the GET response only reports `hasKey: true` and a
 * masked tail. To rotate, paste a new key.
 */
app.get('/api/settings/hermes', async (_req, res) => {
  try {
    const row = await db().swarmSettings.findUnique({ where: { id: 'global' } });
    return res.json({
      enabled: row?.hermesEnabled ?? false,
      hasKey: !!row?.hermesApiKey,
      // Only the last 4 chars are shown — enough to recognize "is this the
      // key I pasted earlier?" without exposing it on the wire on every
      // page load.
      keyTail: row?.hermesApiKey ? row.hermesApiKey.slice(-4) : null,
      model: row?.hermesModel ?? null,
      baseUrl: row?.hermesBaseUrl ?? null,
      skill: row?.hermesSkill ?? null,
      updatedAt: row?.updatedAt ?? null,
    });
  } catch (err) {
    log.error('get hermes settings failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

interface HermesSettingsPutBody {
  enabled?: boolean;
  /** Send `null` (or omit + clearKey:true) to wipe the stored key. */
  apiKey?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  skill?: string | null;
  /** Explicit "delete the saved key" flag, since omission means "leave alone". */
  clearKey?: boolean;
}

app.put('/api/settings/hermes', async (req, res) => {
  try {
    const body = (req.body ?? {}) as HermesSettingsPutBody;

    const existing =
      (await db().swarmSettings.findUnique({ where: { id: 'global' } })) ?? null;

    // Diff semantics: undefined = leave alone, null = clear, string = overwrite.
    // For the API key specifically we accept either `apiKey: null` or
    // `clearKey: true` so the UI doesn't have to know the convention.
    //
    // Special case: if the caller is wiping the key but didn't explicitly
    // touch `enabled`, force it off. Otherwise we'd land in the
    // enabled=true / no-key state and reject their own request below.
    const isClearingKey = body.clearKey === true || body.apiKey === null;
    const next = {
      hermesEnabled:
        typeof body.enabled === 'boolean'
          ? body.enabled
          : isClearingKey
            ? false
            : existing?.hermesEnabled ?? false,
      hermesApiKey:
        body.clearKey || body.apiKey === null
          ? null
          : typeof body.apiKey === 'string' && body.apiKey.length > 0
            ? body.apiKey
            : (existing?.hermesApiKey ?? null),
      hermesModel:
        body.model === null
          ? null
          : typeof body.model === 'string'
            ? body.model
            : (existing?.hermesModel ?? null),
      hermesBaseUrl:
        body.baseUrl === null
          ? null
          : typeof body.baseUrl === 'string'
            ? body.baseUrl
            : (existing?.hermesBaseUrl ?? null),
      hermesSkill:
        body.skill === null
          ? null
          : typeof body.skill === 'string'
            ? body.skill
            : (existing?.hermesSkill ?? null),
    };

    // Refuse to flip enabled=true with no key on file — surface this
    // early so the UI can render "paste a key first" rather than letting
    // PM crash on the next tick.
    if (next.hermesEnabled && !next.hermesApiKey) {
      return res
        .status(400)
        .json({ error: 'cannot enable Hermes without an API key' });
    }

    const saved = await db().swarmSettings.upsert({
      where: { id: 'global' },
      update: next,
      create: { id: 'global', ...next },
    });

    log.info('hermes settings updated', {
      enabled: saved.hermesEnabled,
      hasKey: !!saved.hermesApiKey,
      model: saved.hermesModel,
      baseUrl: saved.hermesBaseUrl,
      skillLen: saved.hermesSkill?.length ?? 0,
    });

    return res.json({
      enabled: saved.hermesEnabled,
      hasKey: !!saved.hermesApiKey,
      keyTail: saved.hermesApiKey ? saved.hermesApiKey.slice(-4) : null,
      model: saved.hermesModel,
      baseUrl: saved.hermesBaseUrl,
      skill: saved.hermesSkill,
      updatedAt: saved.updatedAt,
    });
  } catch (err) {
    log.error('update hermes settings failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

app.listen(PORT, () => {
  log.info('api up', { port: PORT, allowedOrigins: ALLOWED_ORIGINS });
});
