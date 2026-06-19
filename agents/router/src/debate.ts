// Router-side of the inter-agent debate protocol.
//
// Router listens on swarm.pm.draft and replies on swarm.router.feedback.
// Router's specialty is *executability*: it knows what's actually
// routable on the target chain via Uniswap, what the KH wallet can
// supply, and what's been failing recently. PM uses Router's feedback
// to drop unrouteable symbols and pre-cap suspicious notional sizes
// before the final allocation goes out.

import {
  TOPICS,
  type AgentContext,
  type DraftAllocation,
  type RouterFeedback,
  type SupportedChain,
  type SwarmMessage,
} from '@swarm/shared';
import { resolve } from './tokens.js';

interface StartOptions {
  primaryChain: SupportedChain;
}

export function startDebateListener(
  ctx: AgentContext,
  opts: StartOptions,
): () => void {
  let stopped = false;

  const handle = async (envelope: SwarmMessage<DraftAllocation>) => {
    const draft = envelope.payload;
    if (!draft || draft.kind !== 'draft') return;
    const walletAddress = envelope.walletAddress;
    if (!walletAddress) return;

    const feedback = evaluate(draft, opts.primaryChain);
    if (!feedback) return;

    const reply: SwarmMessage<RouterFeedback> = {
      fromAgent: 'router',
      walletAddress,
      ts: Date.now(),
      payload: feedback,
    };
    await Promise.all([
      ctx.axl
        .publish({ topic: TOPICS.routerFeedback, payload: reply })
        .catch(() => {}),
      ctx.pg
        .publish({
          topic: TOPICS.routerFeedback,
          from: ctx.role,
          payload: reply,
        })
        .catch(() => {}),
    ]);
    ctx.log.info('router feedback posted', {
      walletAddress,
      draftId: draft.draftId,
      severity: feedback.severity,
      unroutable: feedback.unroutableSymbols?.length ?? 0,
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
      // subscriber per-process
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

  return () => {
    stopped = true;
  };
}

/**
 * Evaluate a draft for routability. Today this is a pure-function
 * check using the address map; later iterations could probe Uniswap
 * here too (we already have probeUniswap in preflight.ts but that's
 * gated on KH balance which we don't want to short-circuit at debate
 * time — KH-balance is preflight's job, debate is symbol-coverage's).
 */
function evaluate(
  draft: DraftAllocation,
  chain: SupportedChain,
): RouterFeedback | null {
  const unroutable: string[] = [];
  for (const target of draft.targets) {
    const addr = resolve(target.symbol, chain);
    if (addr === null) {
      unroutable.push(target.symbol.toUpperCase());
    }
  }
  if (unroutable.length === 0) return null;

  return {
    kind: 'router.feedback',
    draftId: draft.draftId,
    concern: `no ${chain} address mapping for: ${unroutable.join(', ')}`,
    unroutableSymbols: unroutable,
    severity: 'warn',
  };
}
