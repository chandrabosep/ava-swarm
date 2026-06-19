import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
}

// HUD button: clipped corners on the larger sizes, neon glow on hover
// for the primary variant. The hover ring stays inside the clip-path so
// it doesn't bleed past the chamfered corners.
const VARIANT: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    'bg-accent text-bg border border-accent shadow-[0_0_12px_-2px_rgba(0,229,255,0.6)] hover:bg-accent/90 hover:shadow-[0_0_18px_0_rgba(0,229,255,0.75)]',
  secondary:
    'bg-bg-hover/70 text-fg border border-border-strong/70 hover:border-accent/70 hover:text-accent hover:shadow-[0_0_10px_-2px_rgba(0,229,255,0.45)]',
  ghost:
    'bg-transparent text-fg-muted border border-transparent hover:text-accent hover:bg-bg-hover/50 hover:border-accent/40',
};

const SIZE: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'h-7 px-2.5 text-[11px]',
  md: 'h-9 px-4 text-xs',
};

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  className = '',
  ...rest
}: ButtonProps) {
  // Notch the top-right + bottom-left so buttons match the HUD surfaces.
  const clip =
    'before:content-[""] before:absolute before:inset-0 before:pointer-events-none';
  return (
    <button
      style={{
        clipPath:
          'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)',
      }}
      className={`relative inline-flex items-center justify-center gap-2
        font-sans font-semibold uppercase tracking-[0.14em] rounded-[2px]
        transition-all duration-150 focus:outline-none
        focus-visible:ring-2 focus-visible:ring-accent/60
        disabled:opacity-50 disabled:pointer-events-none
        ${clip} ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
