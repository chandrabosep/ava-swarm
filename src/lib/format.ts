// Lightweight formatters. Kept dependency-free — `Intl` is available in MV3
// extension pages.

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const pctFormatter = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});

const compactNumber = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
});

export function formatUsd(value: number): string {
  return usdFormatter.format(value);
}

export function formatPct(fraction: number): string {
  return pctFormatter.format(fraction);
}

export function formatCompact(value: number): string {
  return compactNumber.format(value);
}

const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

const RANGES: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 60 * 60 * 24 * 365],
  ['month', 60 * 60 * 24 * 30],
  ['week', 60 * 60 * 24 * 7],
  ['day', 60 * 60 * 24],
  ['hour', 60 * 60],
  ['minute', 60],
  ['second', 1],
];

export function formatRelative(
  when: number | string | Date,
  now: number = Date.now(),
): string {
  // Accept epoch ms, ISO string, or Date — defensive because intent
  // payloads from the agents API arrive as ISO strings.
  let unixMs: number;
  if (typeof when === 'number') unixMs = when;
  else if (when instanceof Date) unixMs = when.getTime();
  else unixMs = Date.parse(when);
  if (!Number.isFinite(unixMs)) return '—';
  const deltaSec = Math.round((unixMs - now) / 1000);
  const abs = Math.abs(deltaSec);
  for (const [unit, secInUnit] of RANGES) {
    if (abs >= secInUnit || unit === 'second') {
      return rtf.format(Math.round(deltaSec / secInUnit), unit);
    }
  }
  return rtf.format(deltaSec, 'second');
}

export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
