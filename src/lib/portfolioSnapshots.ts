// Client-side portfolio snapshot store.
//
// Why this exists: Zerion gives a single fixed `changes.percent_1d` (24h
// delta) on the portfolio response, and Alchemy gives nothing at all.
// Neither provider exposes the historical wallet value we'd need to
// compute shorter-window movement (1h, 5h, etc.). So we record our own
// snapshots in localStorage on every successful portfolio fetch, and
// diff against the snapshot closest to (now - interval) when the
// dashboard wants to render a "ΔXh" pill.
//
// Bounded retention: we keep ~26 hours of history per wallet so the
// "24h" mode still works as a fallback. Anything older gets pruned on
// every write.
//
// Storage shape:
//   localStorage key: `swarm.portfolio.snapshots.<addressLower>`
//   value: PortfolioSnapshot[] (ascending by ts)

const STORAGE_PREFIX = 'swarm.portfolio.snapshots.';
const MAX_AGE_MS = 26 * 60 * 60 * 1000; // 26h
const MAX_ENTRIES = 600; // hard ceiling so a tab refresh loop can't blow up storage

export interface PortfolioSnapshot {
  /** Unix ms when this snapshot was recorded. */
  ts: number;
  /** Total wallet value in USD at that time. */
  totalUsd: number;
  /** USD parked in stables (USDC for now). Lets the UI render Stable Ratio without a re-fetch. */
  stablesUsd: number;
}

function key(address: string): string {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

function readAll(address: string): PortfolioSnapshot[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive shape check — a malformed entry shouldn't crash the dashboard.
    return parsed.filter(
      (s): s is PortfolioSnapshot =>
        typeof s?.ts === 'number' &&
        typeof s?.totalUsd === 'number' &&
        typeof s?.stablesUsd === 'number',
    );
  } catch {
    return [];
  }
}

function writeAll(address: string, snapshots: PortfolioSnapshot[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key(address), JSON.stringify(snapshots));
  } catch {
    // Storage full / disabled — non-fatal.
  }
}

/**
 * Append a new snapshot. Caller is expected to call this once per
 * successful portfolio fetch. We dedupe on a 30s window so a flurry of
 * background refreshes doesn't flood the array.
 */
export function recordSnapshot(
  address: string,
  totalUsd: number,
  stablesUsd: number,
): void {
  if (!address) return;
  const now = Date.now();
  const all = readAll(address);

  // Dedupe: if the most recent entry is < 30s old, replace it instead of
  // appending. Keeps the array growth proportional to wall-clock time.
  const last = all[all.length - 1];
  const next: PortfolioSnapshot = { ts: now, totalUsd, stablesUsd };
  const merged =
    last && now - last.ts < 30_000
      ? [...all.slice(0, -1), next]
      : [...all, next];

  // Prune old + cap length.
  const cutoff = now - MAX_AGE_MS;
  const pruned = merged.filter((s) => s.ts >= cutoff).slice(-MAX_ENTRIES);

  writeAll(address, pruned);
}

export interface IntervalChange {
  /** Snapshot we used as the "before" reference. Null if we don't have enough history. */
  reference: PortfolioSnapshot | null;
  /** USD delta (current − reference). 0 if no reference. */
  absoluteUsd: number;
  /** Fraction (e.g. 0.0241 = +2.41%). 0 if no reference or reference value was 0. */
  percent: number;
  /** How old the reference snapshot is, in ms. Helps the UI write a precise label. */
  ageMs: number;
}

/**
 * Compute the change in `totalUsd` against the snapshot closest to
 * (now - intervalMs). If the oldest snapshot we have is younger than
 * the requested interval, we fall back to that oldest snapshot and let
 * the UI render the actual age it's reading off.
 *
 * Returns a zeroed IntervalChange when we have fewer than 2 snapshots —
 * the card should render "—" / "warming up" in that case.
 */
export function changeOverInterval(
  address: string,
  currentUsd: number,
  intervalMs: number,
): IntervalChange {
  const all = readAll(address);
  if (all.length === 0) {
    return { reference: null, absoluteUsd: 0, percent: 0, ageMs: 0 };
  }

  const now = Date.now();
  const target = now - intervalMs;

  // Find the snapshot whose ts is closest to (and ideally <=) target.
  // Walk from the front since list is ascending; the snapshot we want
  // is the LAST one with ts <= target, falling back to the oldest if
  // every snapshot is younger than the interval.
  let reference: PortfolioSnapshot | null = null;
  for (const s of all) {
    if (s.ts <= target) reference = s;
    else break;
  }
  if (!reference) reference = all[0]; // every snapshot is younger than interval

  const absoluteUsd = currentUsd - reference.totalUsd;
  const percent =
    reference.totalUsd > 0 ? absoluteUsd / reference.totalUsd : 0;
  return {
    reference,
    absoluteUsd,
    percent,
    ageMs: now - reference.ts,
  };
}

/** Most recent snapshot, if any. Lets UI render "last updated" timestamps. */
export function latestSnapshot(address: string): PortfolioSnapshot | null {
  const all = readAll(address);
  return all.length > 0 ? all[all.length - 1] : null;
}
