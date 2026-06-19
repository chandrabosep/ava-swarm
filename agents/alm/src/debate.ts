// ALM-side of the inter-agent debate protocol.
//
// ALM listens on swarm.pm.draft and replies on swarm.alm.feedback.
// ALM's specialty is LP position context: it pushes back when a draft
// would force out-of-range LP positions or starve a pool that needs
// inventory. PM has the final word but reconciles using ALM's
// adjustments before committing the allocation.

import {
  TOPICS,
  type AgentContext,
  type AlmFeedback,
  type DraftAllocation,
  type SwarmMessage,
} from '@swarm/shared';

/** Stable symbols that ALM treats as the "stable floor" lever. */
const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'PYUSD', 'FDUSD']);

/** Volatile symbols ALM has LP positions on (placeholder until we read
 *  positions onchain in Day 3 PM's ALM-LP work). */
const LP_INVENTORY: Record<string, { needsMin: number; needsMax: number }> = {
  ETH: { needsMin: 0.3, needsMax: 0.85 },
  WBTC: { needsMin: 0.0, needsMax: 0.4 },
};

export function startDebateListener(ctx: AgentContext): () => void {
  let stopped = false;

  const run = async () => {
    // Subscribe on PG (single-host instant) and AXL (multi-host gossip)
    // in parallel. Either delivery is sufficient.
    const handle = async (envelope: SwarmMessage<DraftAllocation>) => {
      const draft = envelope.payload;
      if (!draft || draft.kind !== 'draft') return;
      const walletAddress = envelope.walletAddress;
      if (!walletAddress) return;

      const feedback = evaluate(draft);
      if (!feedback) return;

      const reply: SwarmMessage<AlmFeedback> = {
        fromAgent: 'alm',
        walletAddress,
        ts: Date.now(),
        payload: feedback,
      };
      // Fire on both transports — PM listens on PG; AXL is the
      // multi-host story.
      await Promise.all([
        ctx.axl
          .publish({ topic: TOPICS.almFeedback, payload: reply })
          .catch(() => {}),
        ctx.pg
          .publish({
            topic: TOPICS.almFeedback,
            from: ctx.role,
            payload: reply,
          })
          .catch(() => {}),
      ]);
      ctx.log.info('alm feedback posted', {
        walletAddress,
        draftId: draft.draftId,
        severity: feedback.severity,
        adjustments: feedback.adjustments?.length ?? 0,
      });
    };

    void (async () => {
      try {
        for await (const msg of ctx.pg.subscribe<SwarmMessage<DraftAllocation>>(
          TOPICS.pmDraft,
        )) {
          if (stopped) return;
          if (msg.payload) await handle(msg.payload);
        }
      } catch {
        // ignore — subscriber lifecycle is per-process
      }
    })();
    void (async () => {
      try {
        for await (const msg of ctx.axl.subscribe<SwarmMessage<DraftAllocation>>(
          TOPICS.pmDraft,
        )) {
          if (stopped) return;
          if (msg.payload) await handle(msg.payload);
        }
      } catch {
        // ignore
      }
    })();
  };

  void run();

  return () => {
    stopped = true;
  };
}

/**
 * Heuristic check: if PM proposes weights that would force LP inventory
 * out of bounds, push back. The bounds are static today; once Day 3
 * wires real v4 position monitoring we'll source `LP_INVENTORY` from
 * actual on-chain reads.
 */
function evaluate(draft: DraftAllocation): AlmFeedback | null {
  const adjustments: NonNullable<AlmFeedback['adjustments']> = [];
  let severity: AlmFeedback['severity'] = 'info';
  const concerns: string[] = [];

  for (const target of draft.targets) {
    const sym = target.symbol.toUpperCase();
    const inv = LP_INVENTORY[sym];
    if (!inv) continue;
    if (target.weight < inv.needsMin) {
      const delta = inv.needsMin - target.weight;
      adjustments.push({
        symbol: sym,
        deltaWeight: delta,
        reason: `LP pool needs ≥ ${(inv.needsMin * 100).toFixed(0)}% ${sym} inventory`,
      });
      concerns.push(`${sym} below LP min (${(target.weight * 100).toFixed(0)}% < ${(inv.needsMin * 100).toFixed(0)}%)`);
      severity = 'warn';
    } else if (target.weight > inv.needsMax) {
      const delta = inv.needsMax - target.weight;
      adjustments.push({
        symbol: sym,
        deltaWeight: delta,
        reason: `LP pool capped at ${(inv.needsMax * 100).toFixed(0)}% ${sym}`,
      });
      concerns.push(`${sym} above LP max`);
      severity = 'warn';
    }
  }

  // Stable starvation check — if total stables < 5%, ALM pushes back
  // because LP rebalances need stable inventory to settle into.
  const stableTotal = draft.targets
    .filter((t) => STABLE_SYMBOLS.has(t.symbol.toUpperCase()))
    .reduce((s, t) => s + t.weight, 0);
  if (stableTotal < 0.05 && stableTotal > 0) {
    concerns.push(
      `stables ${(stableTotal * 100).toFixed(1)}% < ALM rebalance buffer (5%)`,
    );
    if (severity === 'info') severity = 'warn';
  }

  if (adjustments.length === 0 && concerns.length === 0) return null;

  return {
    kind: 'alm.feedback',
    draftId: draft.draftId,
    concern: concerns.join('; ') || undefined,
    adjustments: adjustments.length > 0 ? adjustments : undefined,
    severity,
  };
}
