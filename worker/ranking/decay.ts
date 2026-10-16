import { RANKING_CONFIG } from './config.ts';

/**
 * Computes decayed signal weight given elapsed time since last update.
 * Formula: weight * (0.5 ^ (elapsedMs / halfLifeMs))
 */
export function computeDecayedWeight(
  storedWeight: number,
  updatedAtIso: string,
  nowMs = Date.now()
): number {
  const updatedMs = new Date(updatedAtIso).getTime();
  const elapsedMs = Math.max(0, nowMs - updatedMs);
  const decayFactor = Math.pow(0.5, elapsedMs / RANKING_CONFIG.HALF_LIFE_MS);
  return storedWeight * decayFactor;
}
