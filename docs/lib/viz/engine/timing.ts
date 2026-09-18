/**
 * Simulated cost model for teaching — deterministic, not wall-clock.
 * Scale playback with the UI speed control; these are relative weights.
 */

export interface TimingWeights {
  base: number;
  perItem: number;
  perSource: number;
  perScript: number;
  perFile: number;
  perCondition: number;
}

const DEFAULT: TimingWeights = {
  base: 12,
  perItem: 18,
  perSource: 22,
  perScript: 40,
  perFile: 14,
  perCondition: 10,
};

/**
 * Compute a simulated duration for a phase.
 * @param kind - Cost driver category
 * @param count - How many units of work
 * @param weights - Optional override weights
 */
export function simulatedDurationMs(
  kind: keyof Omit<TimingWeights, "base"> | "noop",
  count = 1,
  weights: TimingWeights = DEFAULT,
): number {
  if (kind === "noop") return Math.max(1, Math.round(weights.base * 0.35));
  const unit = weights[kind];
  return Math.max(1, Math.round(weights.base + unit * Math.max(0, count)));
}
