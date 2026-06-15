import type { HTMLAttributes, ReactNode } from 'react';

interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  variant?: 'default' | 'raised';
}

export function Surface({
  children,
  variant = 'default',
  className = '',
  ...rest
}: SurfaceProps) {
  const base = variant === 'raised' ? 'surface-raised' : 'surface';
  return (
    <div className={`${base} ${className}`} {...rest}>
      {children}
    </div>
  );
}
