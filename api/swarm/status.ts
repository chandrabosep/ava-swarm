// Live swarm status endpoint — read-only window into Supabase for the
// dashboard. Returns:
//   - agents[]: per-role last-seen timestamp + active session count
//   - recentEvents[]: latest 30 events across all users (otc matches,
//                     intent.executed, etc.) so the UI can render a feed
//
// Why a serverless function instead of supabase-js in the browser:
// the dashboard is unauthenticated against Supabase (no RLS rules set up
// for hackathon scope) — we'd have to expose the anon key + scope rows
// per safeAddress. Server-side query with a single read-only connection
// is simpler and keeps DATABASE_URL off the client.
//
// Cache: a single `pg` Pool is hoisted to module scope so warm Vercel
// invocations reuse connections.

import { Pool } from 'pg';

import type { VercelRequest, VercelResponse } from '@vercel/node';

const url = process.env.DATABASE_URL ?? process.env.DIRECT_URL;
const pool = url ? new Pool({ connectionString: url, max: 2 }) : null;

interface AgentRow {
  agent: string;
  last_seen: string;
  active_sessions: number;
}

interface EventRow {
  id: string;
  safe_address: string;
  agent: string | null;
  kind: string;
  payload: unknown;
  created_at: string;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (!pool) {
    res.status(503).json({ error: 'database not configured' });
    return;
  }

  res.setHeader('Cache-Control', 's-maxage=2, stale-while-revalidate=10');

  try {
    // Liveness: agents that wrote an agent_state row recently. The agent
    // ticks upsert agent_state per (agent, safeAddress), so MAX(updated_at)
    // grouped by agent gives a clean "last alive" signal — no schema
    // migration needed.
    const { rows: agentRows } = await pool.query<AgentRow>(`
      SELECT
        a.agent::text                      AS agent,
        a.last_seen,
        COALESCE(s.active_sessions, 0)::int AS active_sessions
      FROM (
        SELECT agent, MAX(updated_at) AS last_seen
        FROM agent_state
        GROUP BY agent
      ) a
      LEFT JOIN (
        SELECT agent, COUNT(*) AS active_sessions
        FROM sessions
        WHERE valid_until > NOW()
        GROUP BY agent
      ) s ON s.agent = a.agent
    `);

    const { rows: eventRows } = await pool.query<EventRow>(`
      SELECT id, safe_address, agent::text AS agent, kind, payload, created_at
      FROM events
      ORDER BY created_at DESC
      LIMIT 30
    `);

    res.status(200).json({
      agents: agentRows.map((r) => ({
        role: r.agent,
        lastSeen: new Date(r.last_seen).getTime(),
        activeSessions: r.active_sessions,
      })),
      recentEvents: eventRows.map((r) => ({
        id: r.id,
        safeAddress: r.safe_address,
        agent: r.agent,
        kind: r.kind,
        payload: r.payload,
        createdAt: new Date(r.created_at).getTime(),
      })),
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
