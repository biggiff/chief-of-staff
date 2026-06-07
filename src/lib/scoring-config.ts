import type { AttentionType, Role } from "@/db";

/**
 * Attention scoring is config-driven, never hard-coded at the call site.
 *
 * `attentionWeightsForRole()` is the single seam through which weights are
 * resolved — today it returns global defaults (optionally merged with a
 * per-role override stored on `roles.scoringConfig`), but it's structured so
 * weights can fully vary by role later (e.g. a Wife role weighting
 * `relationship` highest, a Founder role weighting `progress` highest) without
 * touching the scoring algorithm.
 */

export type ScoringConfig = {
  attentionWeights?: Partial<Record<AttentionType, number>>;
};

// Higher weight = more "health credit" per unit of attention.
// Progress counts most; rest/thinking least. These are deliberately just
// defaults — see attentionWeightsForRole for per-role overrides.
export const DEFAULT_ATTENTION_WEIGHTS: Record<AttentionType, number> = {
  progress: 3.0,
  focused_work: 2.4,
  relationship: 2.0,
  planning: 1.5,
  maintenance: 1.4,
  thinking: 1.2,
  rest: 0.5,
};

export function attentionWeightsForRole(
  role: Pick<Role, "scoringConfig">
): Record<AttentionType, number> {
  const cfg = (role.scoringConfig as ScoringConfig | null) ?? null;
  if (!cfg?.attentionWeights) return DEFAULT_ATTENTION_WEIGHTS;
  return { ...DEFAULT_ATTENTION_WEIGHTS, ...cfg.attentionWeights };
}

// How far back attention events count toward health, and how they decay.
export const ATTENTION_WINDOW_DAYS = 21;

/** Linear recency decay: 1.0 today → 0 at the window edge. */
export function recencyFactor(daysAgo: number): number {
  return Math.max(0, 1 - daysAgo / ATTENTION_WINDOW_DAYS);
}

/** Duration scales credit but with diminishing returns (cap at ~3 units). */
export function durationFactor(durationMinutes: number | null): number {
  if (!durationMinutes || durationMinutes <= 0) return 1;
  return Math.min(durationMinutes / 60, 3);
}

// Cap how much accumulated attention can offset a role's pressure score, so a
// flurry of logging can't drive a genuinely neglected role to "thriving".
export const MAX_ATTENTION_CREDIT = 8;
