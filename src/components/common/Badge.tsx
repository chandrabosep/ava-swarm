import type { ReactNode } from 'react';

type Tone = 'neutral' | 'positive' | 'negative' | 'warning' | 'accent';

const TONES: Record<Tone, string> = {
  neutral: 'bg-bg-hover border-border text-fg-muted',
  positive: 'bg-positive/10 border-positive/30 text-positive',
  negative: 'bg-negative/10 border-negative/30 text-negative',
  warning: 'bg-warning/10 border-warning/30 text-warning',
  accent: 'bg-accent/10 border-accent/30 text-accent',
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
          className="size-1.5 rounded-full bg-current opacity-80"
        />
      )}
      {children}
    </span>
  );
}
