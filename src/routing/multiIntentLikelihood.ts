import { MULTI_INTENT_LIKELIHOOD_CONFIG } from './deterministic/config/routingDeterministicConfig';

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while (idx >= 0) {
    idx = haystack.indexOf(needle, idx);
    if (idx < 0) break;
    count += 1;
    idx += needle.length;
  }
  return count;
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Lightweight multi-intent signal used by semantic runtime gating.
 * 0 means likely single-intent, 1 means highly likely multi-intent.
 */
export function estimateMultiIntentLikelihood(text: string): number {
  const cfg = MULTI_INTENT_LIKELIHOOD_CONFIG;
  const normalized = ` ${text.toLowerCase().replace(/\s+/g, ' ').trim()} `;
  if (!normalized.trim()) return 0;

  const markerCount = cfg.coordinationMarkers.reduce(
    (sum, marker) => sum + countOccurrences(normalized, marker),
    0,
  );

  const segments = normalized.split(/[!?;.]+/).map((s) => s.trim()).filter(Boolean);
  const segmentScore = segments.length > 1
    ? Math.min(cfg.weights.segmentMax, (segments.length - 1) * cfg.weights.segmentStep)
    : 0;

  const verbCount = cfg.actionVerbs.reduce(
    (sum, verb) => sum + countOccurrences(normalized, ` ${verb} `),
    0,
  );
  const extraVerbScore = verbCount > 1
    ? Math.min(cfg.weights.extraVerbMax, (verbCount - 1) * cfg.weights.extraVerbStep)
    : 0;

  const markerScore = Math.min(cfg.weights.markerMax, markerCount * cfg.weights.markerStep);
  return clamp01(markerScore + segmentScore + extraVerbScore);
}
