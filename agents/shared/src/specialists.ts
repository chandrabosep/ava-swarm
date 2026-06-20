// The specialist catalog — the single source of truth both halves of the
// "agents that hire agents" demo agree on.
//
//   - The marketplace server (sellers) mounts one x402-gated route per entry,
//     each settling to that specialist's own wallet.
//   - PM (the buyer) reads this list to know who it can hire, what each
//     charges, and which ERC-8004 feedback tag to use after a job.
//
// Three of the swarm's four agents become sellers; PM is the buyer.

import type { AgentRole } from './db.js';

export interface Specialist {
  /** Existing swarm agent acting as this seller; its service wallet is payTo. */
  role: Extract<AgentRole, 'router' | 'executor' | 'alm'>;
  /** Path on the marketplace server. */
  path: string;
  /** x402 price, dollar string (USDC). */
  price: string;
  /** ERC-8004 feedback category written after a job. */
  tag: string;
  /** Human label for the dashboard. */
  label: string;
  /** What the buyer is paying for. */
  description: string;
}

export const SPECIALISTS: readonly Specialist[] = [
  {
    role: 'router',
    path: '/quote-route',
    price: '$0.01',
    tag: 'quote',
    label: 'Route Analyst',
    description: 'Best-route + quote analysis for a swap.',
  },
  {
    role: 'executor',
    path: '/risk-check',
    price: '$0.01',
    tag: 'risk',
    label: 'Risk Checker',
    description: 'Pre-trade risk assessment for a token + size.',
  },
  {
    role: 'alm',
    path: '/price',
    price: '$0.005',
    tag: 'data',
    label: 'Data Oracle',
    description: 'Token price + sentiment snapshot.',
  },
] as const;

export function specialistByRole(role: AgentRole): Specialist | undefined {
  return SPECIALISTS.find((s) => s.role === role);
}
