/** Longest symptom text scored; the MCP schemas advertise the same cap, this enforces it. */
const MAX_SYMPTOM_LENGTH = 256

/** The trimmed, capped query, or undefined when there is nothing to rank by. */
export function symptomQuery(symptom: string | undefined): string | undefined {
  const query = symptom?.trim().slice(0, MAX_SYMPTOM_LENGTH)
  return query === undefined || query.length === 0 ? undefined : query
}

/** The best-scoring entries for a query, highest first, at most `limit` (1 to 5, default 3). */
export function rankBySymptom<T>(
  entries: readonly T[],
  query: string,
  limit: number | undefined,
  score: (entry: T, words: readonly string[]) => number,
): T[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1)
  return entries
    .map((entry) => ({ entry, s: score(entry, words) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.min(Math.max(limit ?? 3, 1), 5))
    .map((r) => r.entry)
}
