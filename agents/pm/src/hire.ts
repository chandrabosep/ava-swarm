// PM as the buyer — the "agents that hire agents" loop.
//
// Each round PM:
//   1. ranks the specialist sellers by their ERC-8004 reputation,
//   2. hires the top N (PM_HIRE_PER_TICK),
//   3. pays each one per-task via x402 (USDC on Fuji, gasless, no human),
//   4. scores the delivered result and writes ERC-8004 feedback back,
//      which changes who ranks highest next round.
//
// This is self-contained: it does NOT depend on user sessions or portfolio
// data, so the demo runs as soon as the PM wallet holds Fuji USDC + a little
// AVAX. Every payment + feedback is persisted as an Event the dashboard reads.

import { wrapFetchWithPayment, createSigner, decodeXPaymentResponse } from 'x402-fetch';

import {
  db,
  env,
  getReputation,
  giveFeedback,
  SPECIALISTS,
  serviceAddress,
  type AgentContext,
  type Specialist,
} from '@swarm/shared';

/** Demo activity is keyed to this sentinel wallet (no real user involved). */
const MARKET_KEY = '0x0000000000000000000000000000000000000000';

const HIRE_INTERVAL_MS =
  (parseFloat(process.env.PM_HIRE_INTERVAL_SEC ?? '45') || 45) * 1_000;

/** A made-up job, split into the sub-tasks each specialist can fulfill. */
function jobInputFor(s: Specialist): Record<string, unknown> {
  switch (s.role) {
    case 'router':
      return { tokenIn: 'USDC', tokenOut: 'WAVAX', amountIn: 100 };
    case 'executor':
      return { token: 'WAVAX', amountUsd: 100 };
    case 'alm':
      return { token: 'AVAX' };
  }
}

/** Turn a specialist's result into a 0..100 quality score for feedback. */
function scoreResult(s: Specialist, result: Record<string, unknown>): number {
  switch (s.role) {
    case 'router': {
      // Tighter price impact → higher score.
      const bps = Number(result.priceImpactBps ?? 50);
      return Math.max(0, Math.min(100, Math.round(100 - bps)));
    }
    case 'executor': {
      const verdict = String(result.verdict ?? 'caution');
      return verdict === 'ok' ? 95 : verdict === 'caution' ? 70 : 40;
    }
    case 'alm': {
      // Reward a confident (non-neutral) read.
      return result.sentiment === 'neutral' ? 65 : 85;
    }
  }
}

function agentIdFor(s: Specialist): number | null {
  const pinned = env.erc8004AgentId(s.role);
  return pinned ? Number(pinned) : null;
}

export function startHireLoop(ctx: AgentContext): () => void {
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    try {
      await runHiringRound(ctx);
    } catch (err) {
      ctx.log.error('hiring round failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };
  void run();
  const id = setInterval(run, HIRE_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}

export async function runHiringRound(ctx: AgentContext): Promise<void> {
  // The PM service key is the buyer's wallet — it must hold Fuji USDC + AVAX.
  const pmPriv = process.env.PM_SERVICE_PRIVKEY;
  if (!pmPriv) {
    ctx.log.warn('hire: PM_SERVICE_PRIVKEY unset — cannot pay, skipping round');
    return;
  }
  const privHex = (pmPriv.startsWith('0x') ? pmPriv : `0x${pmPriv}`) as `0x${string}`;
  const signer = await createSigner(env.x402Network(), privHex);
  const fetchWithPay = wrapFetchWithPayment(fetch, signer);
  const base = env.marketplaceUrl().replace(/\/$/, '');

  // 1. Rank specialists by ERC-8004 reputation (best first).
  const ranked = await Promise.all(
    SPECIALISTS.map(async (s) => {
      const agentId = agentIdFor(s);
      const rep = agentId !== null ? await getReputation(agentId) : { avgScore: 50, count: 0 };
      return { s, agentId, rep };
    }),
  );
  ranked.sort((a, b) => b.rep.avgScore - a.rep.avgScore);

  const perTick = Math.max(1, Number(env_default('PM_HIRE_PER_TICK', '3')));
  const chosen = ranked.slice(0, perTick);
  ctx.log.info('hiring round', {
    candidates: ranked.map((r) => `${r.s.role}:${r.rep.avgScore}(${r.rep.count})`),
    hiring: chosen.map((c) => c.s.role),
  });

  // 2. Hire each chosen specialist: pay via x402, score, leave feedback.
  for (const { s, agentId, rep } of chosen) {
    const url = `${base}${s.path}`;
    try {
      const res = await fetchWithPay(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jobInputFor(s)),
      });
      if (!res.ok) {
        // Capture the response body so the real reason (e.g. insufficient
        // funds / settlement failure from the facilitator) is recorded, not
        // just the bare 402 status.
        const bodyText = await res.text().catch(() => '');
        let reason: string = bodyText;
        try {
          const j = JSON.parse(bodyText) as { error?: string; message?: string };
          reason = j.error || j.message || bodyText;
        } catch {
          /* non-JSON body — keep raw text */
        }
        ctx.log.warn('hire: specialist returned non-200', {
          role: s.role,
          status: res.status,
          reason,
        });
        await recordEvent(s, agentId, rep.avgScore, {
          ok: false,
          status: res.status,
          error: reason ? String(reason).slice(0, 400) : 'no body',
        });
        continue;
      }
      const result = (await res.json()) as Record<string, unknown>;

      // Pull the on-chain settlement tx from the x402 response header.
      let payTxHash: string | undefined;
      const payHeader = res.headers.get('x-payment-response');
      if (payHeader) {
        try {
          const decoded = decodeXPaymentResponse(payHeader) as { transaction?: string };
          payTxHash = decoded?.transaction;
        } catch {
          /* header present but undecodable — still a paid call */
        }
      }

      const score = scoreResult(s, result);
      ctx.log.info('hired specialist', {
        role: s.role,
        price: s.price,
        payTxHash,
        score,
        result,
      });

      // 3. Write ERC-8004 feedback (changes next round's ranking).
      let feedbackTx: string | null = null;
      if (agentId !== null) {
        feedbackTx = await giveFeedback('pm', agentId, score, s.tag).catch((err: unknown) => {
          ctx.log.warn('giveFeedback failed', {
            role: s.role,
            err: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
      }

      await recordEvent(s, agentId, rep.avgScore, {
        ok: true,
        price: s.price,
        payTo: serviceAddress(s.role),
        payTxHash,
        score,
        feedbackTx,
        result,
      });
    } catch (err) {
      ctx.log.warn('hire: payment/call failed', {
        role: s.role,
        err: err instanceof Error ? err.message : String(err),
      });
      await recordEvent(s, agentId, rep.avgScore, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function recordEvent(
  s: Specialist,
  agentId: number | null,
  repBefore: number,
  detail: Record<string, unknown>,
): Promise<void> {
  await db().event.create({
    data: {
      walletAddress: MARKET_KEY,
      agent: 'pm',
      kind: 'x402.hire',
      payload: {
        specialist: s.role,
        label: s.label,
        tag: s.tag,
        agentId,
        repBefore,
        ...detail,
      },
    },
  });
}

/** Small helper: process.env with a default (env.ts has no PM_HIRE_PER_TICK). */
function env_default(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
