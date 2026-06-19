// Per-user risk profile knobs.
//
// PM reads the user's profile on every tick and uses it to build the
// LLM system prompt, set the rebalance tolerance, and decide whether
// the user is even due for a tick (cadenceMinutes).

export type RiskProfile = 'conservative' | 'balanced' | 'aggressive' | 'degen';

export interface ProfileConfig {
  /** Stablecoin floor as a fraction (0.6 = 60%). */
  stableFloor: number;
  /** Max fraction in any single non-stable token (0.4 = 40%). */
  maxToken: number;
  /** Max absolute weight shift per tick (0.2 = 20%). Smooths big swings. */
  maxShiftPerTick: number;
  /** Router tolerance in bps (300 = 3%). Drift below this → no swap. */
  toleranceBps: number;
  /** Minimum minutes between PM ticks for this profile. */
  cadenceMinutes: number;
  /** Free-form persona injected into the LLM system prompt. */
  persona: string;
}

export const PROFILES: Record<RiskProfile, ProfileConfig> = {
  conservative: {
    stableFloor: 0.6,
    maxToken: 0.4,
    maxShiftPerTick: 0.1,
    toleranceBps: 1000, // 10%
    cadenceMinutes: 60,
    persona:
      'You are an extremely conservative DeFi portfolio manager. Capital preservation is the primary goal. Stables-heavy at all times. Avoid any speculative positioning. React slowly to market moves.',
  },
  balanced: {
    stableFloor: 0.2,
    maxToken: 0.5,
    maxShiftPerTick: 0.2,
    toleranceBps: 500, // 5%
    cadenceMinutes: 30,
    persona:
      'You are a balanced DeFi portfolio manager. Diversified exposure across the allowed universe with moderate growth tilt. Steady rebalancing without overtrading.',
  },
  aggressive: {
    stableFloor: 0.05,
    maxToken: 0.7,
    maxShiftPerTick: 0.3,
    toleranceBps: 200, // 2%
    cadenceMinutes: 5,
    persona:
      'You are an aggressive DeFi portfolio manager focused on growth. Accept volatility. Move decisively on momentum. Keep only a thin stablecoin reserve.',
  },
  degen: {
    stableFloor: 0,
    maxToken: 0.95,
    maxShiftPerTick: 0.5,
    toleranceBps: 100, // 1%
    cadenceMinutes: 1,
    persona:
      'You are a degen DeFi trader. No stablecoin floor. Concentrate aggressively into whatever has best near-term momentum. Reverse hard when the trend breaks.',
  },
};

export function profileFor(name: string | null | undefined): {
  name: RiskProfile;
  config: ProfileConfig;
} {
  const key = (name ?? 'balanced') as RiskProfile;
  if (PROFILES[key]) return { name: key, config: PROFILES[key] };
  return { name: 'balanced', config: PROFILES.balanced };
}

/**
 * Merge a user's persisted overrides on top of their preset. Any field
 * present in `overrides` wins; missing fields fall back to the preset.
 */
export function resolveConfig(
  presetName: string | null | undefined,
  overrides: Partial<ProfileConfig> | null | undefined,
): { name: RiskProfile; config: ProfileConfig; isCustom: boolean } {
  const { name, config } = profileFor(presetName);
  if (!overrides || Object.keys(overrides).length === 0) {
    return { name, config, isCustom: false };
  }
  return {
    name,
    config: { ...config, ...overrides },
    isCustom: true,
  };
}
