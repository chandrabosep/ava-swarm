// Client-side demo risk-profile store.
//
// In demo mode the Risk Profile card has no backend to PUT to, so the
// selected profile lives here (persisted in localStorage). Switching it
// notifies subscribers, so every hook that reads it via useDemoProfile()
// re-renders — which changes their react-query keys and refetches the
// profile-specific demo feed + allocation immediately.

import { useSyncExternalStore } from 'react';
import type { RiskProfile } from '@/hooks/useSwarmStatus';

const STORAGE_KEY = 'demo:riskProfile';
const VALID: RiskProfile[] = ['conservative', 'balanced', 'aggressive', 'degen'];

const listeners = new Set<() => void>();
let cached: RiskProfile | null = null;

function read(): RiskProfile {
  if (cached) return cached;
  try {
    const v = localStorage.getItem(STORAGE_KEY) as RiskProfile | null;
    cached = v && VALID.includes(v) ? v : 'balanced';
  } catch {
    cached = 'balanced';
  }
  return cached;
}

export function getDemoProfile(): RiskProfile {
  return read();
}

export function setDemoProfile(profile: RiskProfile): void {
  cached = profile;
  try {
    localStorage.setItem(STORAGE_KEY, profile);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive read — re-renders the calling component when the profile changes. */
export function useDemoProfile(): RiskProfile {
  return useSyncExternalStore(subscribe, getDemoProfile, getDemoProfile);
}
