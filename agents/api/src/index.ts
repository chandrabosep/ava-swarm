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
// 256KB ceiling — large enough for a full Hermes skill markdown
// (Moltbook's SKILL.md is ~34KB) but still bounded against abuse.
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

app.get('/api/skill', async (_req, res) => {
  try {
    const row = await db().swarmSettings.findUnique({ where: { id: 'global' } });
    return res.json({
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
    });
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
    });

    return res.json({
      hasSkill: !!saved.skillContent,
      hasKey: !!saved.skillApiKey,
      keyTail: keyTail(saved.skillApiKey),
      name: saved.skillName,
      version: saved.skillVersion,
      description: saved.skillDescription,
      contentLength: saved.skillContent?.length ?? 0,
      installedAt: saved.skillInstalledAt,
      updatedAt: saved.updatedAt,
    });
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

app.listen(PORT, () => {
  log.info('api up', { port: PORT, allowedOrigins: ALLOWED_ORIGINS });
});
