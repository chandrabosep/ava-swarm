// Live "what the swarm is doing right now" feed.
//
// Replaces the old IntentsLog + RecentActivity panels. Where those
// showed cryptic database rows, this presents the agent network as a
// chat: each entry is one agent's action, in plain language, with
// token symbols + USD amounts + tx links.
//
// Data: same `useSwarmStatus().data?.intents` array — no new endpoint.
// We just render it more aggressively (group routed siblings, decode
// token addresses to symbols, format USD, expose LLM reasoning).

import { useMemo } from 'react';

import { Surface } from '@/components/common/Surface';
import { Badge } from '@/components/common/Badge';
import { useSwarmStatus, type IntentLogRow } from '@/hooks/useSwarmStatus';
import { txUrl, defaultExplorerChain, type ChainSlug } from '@/lib/explorer';
import { formatRelative } from '@/lib/format';

// ---------------------------------------------------------------------------
// Token + agent visual identity

type AgentRole = 'pm' | 'alm' | 'router' | 'executor';

const AGENT_AVATAR: Record<
  AgentRole,
  { bg: string; ring: string; emoji: string; label: string }
> = {
  pm: {
    bg: 'bg-positive/15',
    ring: 'ring-positive/40',
    emoji: '◎',
    label: 'Portfolio Manager',
  },
  alm: {
    bg: 'bg-accent/15',
    ring: 'ring-accent/40',
    emoji: '◈',
    label: 'Active Liquidity Manager',
  },
  router: {
    bg: 'bg-fg-muted/15',
    ring: 'ring-fg-muted/40',
    emoji: '⇆',
    label: 'Intent Router',
  },
  executor: {
    bg: 'bg-warning/15',
    ring: 'ring-warning/40',
    emoji: '⚡',
    label: 'Swap Executor',
  },
};

const TOKEN_COLOR: Record<string, string> = {
  ETH: 'bg-violet-500/30 text-violet-300 border-violet-500/40',
  WETH: 'bg-violet-500/30 text-violet-300 border-violet-500/40',
  USDC: 'bg-amber-500/30 text-amber-300 border-amber-500/40',
  WBTC: 'bg-orange-500/30 text-orange-300 border-orange-500/40',
  UNI: 'bg-pink-500/30 text-pink-300 border-pink-500/40',
};

function TokenChip({ symbol }: { symbol: string }) {
  const cls =
    TOKEN_COLOR[symbol.toUpperCase()] ??
    'bg-fg-muted/20 text-fg border-border';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-mono ${cls}`}
    >
      {symbol.toUpperCase()}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Token-address → symbol resolver. Covers mainnet + sepolia + base. Falls
// back to a short address if the contract isn't recognized.
const ADDR_SYMBOL: Record<string, string> = {
  // mainnet
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'WBTC',
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': 'UNI',
  // sepolia
  '0xfff9976782d46cc05630d1f6ebab18b2324d6b14': 'WETH',
  '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238': 'USDC',
  '0x29f2d40b0605204364af54ec677bd022da425d03': 'WBTC',
  // base
  '0x4200000000000000000000000000000000000006': 'WETH',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
  // base sepolia USDC
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': 'USDC',
};

function symbolOf(addr: string): string {
  if (!addr) return '';
  const lc = addr.toLowerCase();
  if (lc === '0x0000000000000000000000000000000000000000') return 'ETH';
  return ADDR_SYMBOL[lc] ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function chainSlug(c: unknown): ChainSlug {
  if (typeof c !== 'string') return defaultExplorerChain;
  const allowed: ChainSlug[] = [
    'mainnet',
    'base',
    'unichain',
    'sepolia',
    'base-sepolia',
  ];
  return allowed.includes(c as ChainSlug)
    ? (c as ChainSlug)
    : defaultExplorerChain;
}

// ---------------------------------------------------------------------------
// Render one row per intent, with kind-specific layout.

interface AllocationPayload {
  kind?: 'allocation';
  targets?: Array<{ symbol: string; weight: number }>;
  rationale?: string;
  profile?: string;
}

interface RoutedPayload {
  kind?: 'routed';
  chain?: string;
  venue?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  notionalUsd?: number;
  origin?: string;
  /** Present when this intent was settled via OTC mesh instead of Uniswap. */
  otc?: {
    peerWallet?: string;
    savedUsd?: number;
    settlementId?: string;
  };
}

interface ReceiptPayload {
  kind?: 'receipt';
  txHash?: string;
  status?: string;
  blockNumber?: string | number | bigint;
}

function AllocationRow({
  intent,
  payload,
}: {
  intent: IntentLogRow;
  payload: AllocationPayload;
}) {
  const targets = payload.targets ?? [];
  const role: AgentRole = 'pm';
  const av = AGENT_AVATAR[role];
  return (
    <div className="flex gap-3">
      <div
        className={`shrink-0 size-7 rounded-full ${av.bg} ring-1 ${av.ring} flex items-center justify-center text-sm`}
      >
        {av.emoji}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-fg">PM</span>
          <span className="text-[10px] text-fg-subtle">
            {formatRelative(intent.createdAt)}
          </span>
        </div>
        <div className="mt-1 text-xs text-fg-muted">
          Proposed allocation{' '}
          {payload.profile && (
            <Badge tone="accent" className="ml-1 align-middle">
              {payload.profile}
            </Badge>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {targets.map((t) => (
            <span
              key={t.symbol}
              className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-bg-raised px-1.5 py-0.5 text-[11px]"
            >
              <TokenChip symbol={t.symbol} />
              <span className="text-fg-muted">
                {Math.round(t.weight * 100)}%
              </span>
            </span>
          ))}
        </div>
        {payload.rationale && (
          <blockquote className="mt-2 border-l-2 border-positive/40 pl-2 text-[11px] italic text-fg-muted leading-snug">
            {payload.rationale}
          </blockquote>
        )}
      </div>
    </div>
  );
}

function RoutedRow({
  intent,
  payload,
  status,
}: {
  intent: IntentLogRow;
  payload: RoutedPayload;
  status: string;
}) {
  const av = AGENT_AVATAR.router;
  const tIn = symbolOf(payload.tokenIn ?? '');
  const tOut = symbolOf(payload.tokenOut ?? '');
  const usd = payload.notionalUsd ?? 0;
  const isOtc = payload.venue === 'otc-mesh' || !!payload.otc;
  const tone = isOtc
    ? 'accent'
    : status === 'executed'
      ? 'positive'
      : status === 'failed'
        ? 'negative'
        : 'warning';
  const chain = chainSlug(payload.chain);
  const statusLabel = isOtc ? 'OTC matched' : status;
  return (
    <div className="flex gap-3">
      <div
        className={`shrink-0 size-7 rounded-full ${av.bg} ring-1 ${av.ring} flex items-center justify-center text-sm`}
      >
        {isOtc ? '⇌' : av.emoji}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-fg">
            {isOtc ? 'Router · OTC' : 'Router'}
          </span>
          <span className="text-[10px] text-fg-subtle">
            {formatRelative(intent.createdAt)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[11px]">
          <TokenChip symbol={tIn} />
          <span className="text-fg-subtle">→</span>
          <TokenChip symbol={tOut} />
          <span className="ml-auto font-mono text-fg-muted">
            ${usd.toFixed(2)}
          </span>
          <Badge tone={tone}>{statusLabel}</Badge>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-fg-subtle">
          {isOtc ? (
            <>
              <span className="text-accent">via AXL mesh · skipped Uniswap</span>
              {payload.otc?.savedUsd != null && (
                <span className="text-positive">
                  saved ${payload.otc.savedUsd.toFixed(2)}
                </span>
              )}
              {payload.otc?.peerWallet && (
                <span className="font-mono">
                  ↔ {payload.otc.peerWallet.slice(0, 6)}…
                  {payload.otc.peerWallet.slice(-4)}
                </span>
              )}
            </>
          ) : (
            <>
              {payload.chain && <span>on {payload.chain}</span>}
              {intent.txHash ? (
                <a
                  href={txUrl(intent.txHash, chain)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono underline decoration-dotted hover:text-accent"
                >
                  {intent.txHash.slice(0, 10)}…{intent.txHash.slice(-4)} ↗
                </a>
              ) : status === 'executed' ? (
                <span className="text-warning">no txHash recorded</span>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ReceiptRow({
  intent,
  payload,
}: {
  intent: IntentLogRow;
  payload: ReceiptPayload;
}) {
  const av = AGENT_AVATAR.executor;
  const tx = payload.txHash;
  const tone =
    payload.status === 'mined' ? 'positive' : payload.status === 'failed' ? 'negative' : 'warning';
  return (
    <div className="flex gap-3">
      <div
        className={`shrink-0 size-7 rounded-full ${av.bg} ring-1 ${av.ring} flex items-center justify-center text-sm`}
      >
        {av.emoji}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-fg">Executor</span>
          <span className="text-[10px] text-fg-subtle">
            {formatRelative(intent.createdAt)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px]">
          <Badge tone={tone}>{payload.status ?? 'submitted'}</Badge>
          {tx && (
            <a
              href={txUrl(tx, defaultExplorerChain)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-fg-muted underline decoration-dotted hover:text-accent"
            >
              {tx.slice(0, 10)}…{tx.slice(-4)} ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel.

export function AgentActivityStream() {
  const status = useSwarmStatus();
  const intents = status.data?.intents ?? [];

  const rows = useMemo(() => {
    // Latest 30 — already ordered desc from the API. Filter out garbage.
    return intents
      .slice(0, 30)
      .filter((i) => i.payload && typeof i.payload === 'object');
  }, [intents]);

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="hud-title text-sm">Agent Feed</h2>
        <span className="text-[10px] text-fg-subtle uppercase tracking-hud font-sans">
          {rows.length} live
        </span>
      </div>
      <Surface className="p-0 overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-5 text-xs text-fg-muted">
            Waiting for the swarm to think… first PM tick lands within the
            cadence window.
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {rows.map((intent) => {
              const p = intent.payload as Record<string, unknown>;
              const kind = (p.kind as string | undefined) ?? '';
              return (
                <li key={intent.id} className="p-3">
                  {kind === 'allocation' ? (
                    <AllocationRow
                      intent={intent}
                      payload={p as AllocationPayload}
                    />
                  ) : kind === 'routed' ? (
                    <RoutedRow
                      intent={intent}
                      payload={p as RoutedPayload}
                      status={intent.status}
                    />
                  ) : kind === 'receipt' ? (
                    <ReceiptRow
                      intent={intent}
                      payload={p as ReceiptPayload}
                    />
                  ) : (
                    <div className="text-[11px] text-fg-muted">
                      {kind || 'unknown intent'} · {intent.status}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Surface>
    </section>
  );
}
