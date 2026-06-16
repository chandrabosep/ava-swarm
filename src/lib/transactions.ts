// Helpers for turning a Zerion transaction into the fields we render.

import type {
  ZerionTransaction,
  ZerionTxStatus,
  ZerionTxTransfer,
} from '@/types/zerion';

export interface TxDisplay {
  /** Bold first line — "USDC → ETH" for swaps, "Sent USDC" for transfers, etc. */
  title: string;
  /** Quieter second line — venue ("Uniswap"), counterparty, or amount. */
  subtitle: string;
  /** UI tone for the status badge. */
  tone: 'positive' | 'negative' | 'warning' | 'neutral' | 'accent';
  /** Status text inside the badge. */
  statusLabel: string;
  /** Unix ms — when the tx was mined; falls back to 0 for pending. */
  timestamp: number;
}

const STATUS_TONE: Record<string, TxDisplay['tone']> = {
  confirmed: 'positive',
  failed: 'negative',
  pending: 'warning',
};

function statusTone(status: ZerionTxStatus): TxDisplay['tone'] {
  return STATUS_TONE[status] ?? 'neutral';
}

function fmtAmount(t: ZerionTxTransfer): string {
  // Use Zerion's pre-formatted numeric string, capped at 4 sig figs visually.
  const n = parseFloat(t.quantity.numeric);
  if (!isFinite(n)) return `${t.quantity.numeric} ${t.fungible_info.symbol}`;
  const formatted =
    n >= 1000
      ? n.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : n >= 1
        ? n.toLocaleString('en-US', { maximumFractionDigits: 3 })
        : n.toLocaleString('en-US', { maximumFractionDigits: 6 });
  return `${formatted} ${t.fungible_info.symbol}`;
}

function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function describeTransaction(tx: ZerionTransaction): TxDisplay {
  const a = tx.attributes;
  const op = a.operation_type;
  const transfers = a.transfers ?? [];
  const out = transfers.find((t) => t.direction === 'out');
  const in_ = transfers.find((t) => t.direction === 'in');
  const venue = a.application_metadata?.name;
  const tone = statusTone(a.status);
  const statusLabel = a.status;
  const timestamp = a.mined_at ? Date.parse(a.mined_at) : 0;

  // Trade / swap: in + out transfers, show pair.
  if (op === 'trade' && out && in_) {
    return {
      title: `${out.fungible_info.symbol} → ${in_.fungible_info.symbol}`,
      subtitle: `${venue ?? 'Swap'} · ${fmtAmount(out)}`,
      tone,
      statusLabel,
      timestamp,
    };
  }

  if (op === 'send' && out) {
    return {
      title: `Sent ${out.fungible_info.symbol}`,
      subtitle: `to ${shortAddr(a.sent_to)} · ${fmtAmount(out)}`,
      tone,
      statusLabel,
      timestamp,
    };
  }

  if (op === 'receive' && in_) {
    return {
      title: `Received ${in_.fungible_info.symbol}`,
      subtitle: `from ${shortAddr(a.sent_from)} · ${fmtAmount(in_)}`,
      tone,
      statusLabel,
      timestamp,
    };
  }

  if (op === 'approve') {
    const sym =
      a.approvals?.[0]?.fungible_info.symbol ?? out?.fungible_info.symbol;
    return {
      title: `Approve ${sym ?? 'token'}`,
      subtitle: venue ?? shortAddr(a.sent_to),
      tone,
      statusLabel,
      timestamp,
    };
  }

  if (op === 'deposit' && out) {
    return {
      title: `Deposit ${out.fungible_info.symbol}`,
      subtitle: `${venue ?? shortAddr(a.sent_to)} · ${fmtAmount(out)}`,
      tone,
      statusLabel,
      timestamp,
    };
  }

  if (op === 'withdraw' && in_) {
    return {
      title: `Withdraw ${in_.fungible_info.symbol}`,
      subtitle: `${venue ?? shortAddr(a.sent_from)} · ${fmtAmount(in_)}`,
      tone,
      statusLabel,
      timestamp,
    };
  }

  // Catch-all: show the operation type with whatever transfer info we have.
  const primary = out ?? in_;
  return {
    title:
      primary && primary.fungible_info.symbol
        ? `${capitalize(op)} ${primary.fungible_info.symbol}`
        : capitalize(op),
    subtitle: venue ?? shortAddr(a.sent_to ?? a.sent_from ?? ''),
    tone,
    statusLabel,
    timestamp,
  };
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}
