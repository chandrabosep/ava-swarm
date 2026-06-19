import type { ReactNode } from 'react';

type Tone = 'neutral' | 'positive' | 'negative' | 'warning' | 'accent';

// HUD chip — bright fill backgrounds + a tiny glow on the colored tones
// to make status reads pop in the dashboard.
const TONES: Record<Tone, string> = {
  neutral:
    'bg-bg-hover/70 border-border-strong/60 text-fg-muted',
  positive:
    'bg-positive/15 border-positive/50 text-positive shadow-[0_0_6px_-1px_rgba(57,255,159,0.55)]',
  negative:
    'bg-negative/15 border-negative/50 text-negative shadow-[0_0_6px_-1px_rgba(255,77,109,0.55)]',
  warning:
    'bg-warning/15 border-warning/50 text-warning shadow-[0_0_6px_-1px_rgba(255,181,71,0.55)]',
  accent:
    'bg-accent/15 border-accent/55 text-accent shadow-[0_0_6px_-1px_rgba(0,229,255,0.55)]',
};

interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}

export function Badge({
  children,
  tone = 'neutral',
  dot = false,
  className = '',
}: BadgeProps) {
  return (
    <span className={`badge ${TONES[tone]} ${className}`}>
      {dot && (
        <span
          aria-hidden
          className="size-1.5 rounded-sm bg-current opacity-90 animate-blink"
        />
      )}
      {children}
    </span>
  );
}
