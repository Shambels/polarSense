/**
 * The closest column names by edit distance. The threshold scales with length so
 * that "id" does not match "at", while a long name tolerates a couple of slips.
 */
export function nearest(typed: string, candidates: string[], limit = 3): string[] {
  const lower = typed.toLowerCase();

  // A pure case difference is the most common near-miss and always worth offering.
  const caseMatch = candidates.filter((c) => c.toLowerCase() === lower && c !== typed);
  if (caseMatch.length) return caseMatch.slice(0, limit);

  const threshold = Math.max(1, Math.floor(typed.length / 3) + 1);
  return candidates
    .filter((candidate) => candidate !== typed)   // an exact match is not a typo
    .map((candidate) => ({ candidate, distance: editDistance(lower, candidate.toLowerCase()) }))
    .filter((entry) => entry.distance <= threshold)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 8) return Infinity;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}
