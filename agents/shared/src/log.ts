// Tiny structured logger. Each agent boot tags its name so multi-agent
// terminal output stays scannable: `[executor] booted`.

export interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  child: (extra: Record<string, unknown>) => Logger;
}

function format(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return '';
  return ' ' + JSON.stringify(meta);
}

export function createLogger(name: string, base: Record<string, unknown> = {}): Logger {
  const merge = (extra?: Record<string, unknown>) => ({ ...base, ...extra });
  return {
    info: (msg, meta) =>
      console.log(`[${name}] ${msg}${format(merge(meta))}`),
    warn: (msg, meta) =>
      console.warn(`[${name}:warn] ${msg}${format(merge(meta))}`),
    error: (msg, meta) =>
      console.error(`[${name}:err]  ${msg}${format(merge(meta))}`),
    child: (extra) => createLogger(name, merge(extra)),
  };
}
