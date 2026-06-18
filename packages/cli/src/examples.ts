/**
 * `nifra_example` — verified, copy-pasteable code examples for agents. The corpus is `examples.json`
 * (written into this package by `bun run gen:llms`): the same doc snippets `check:docs` typechecks
 * against the live `@nifrajs/*` API. So every example this returns is GUARANTEED to compile against the
 * installed version — the antidote to an agent hallucinating a framework API from stale training.
 *
 * Keyword-scored over each example's name/topic/slug (curated identifiers, heavily weighted) and its
 * code body. No query → a grouped index of what's available (the cheap discovery call).
 */

import { countBodyHits, queryTermGroups, tokenize, tokenSetHas } from "./search-terms.ts"

export interface Example {
  readonly name: string
  /** The doc page's title, e.g. "Nifra — Auth & sessions". */
  readonly topic: string
  /** The doc page slug, e.g. "auth" — a short, matchable tag. */
  readonly slug: string
  readonly code: string
}

export interface ScoredExample extends Example {
  readonly score: number
}

/** Score examples against the query: a term in the slug/topic/name (the curated, searchable labels)
 * is worth far more than a mention in the code body; body hits cap per term so one long snippet can't
 * outweigh a precisely-tagged one. */
export function searchExamples(
  examples: readonly Example[],
  query: string,
  limit: number,
): ScoredExample[] {
  const terms = queryTermGroups(query)
  if (terms.length === 0) return []
  const scored: ScoredExample[] = []
  for (const ex of examples) {
    const labelTokens = new Set([...tokenize(ex.slug), ...tokenize(ex.topic), ...tokenize(ex.name)])
    const codeLower = ex.code.toLowerCase()
    let score = 0
    for (const term of terms) {
      if (tokenSetHas(labelTokens, term)) score += 8
      score += countBodyHits(codeLower, term, 5)
    }
    if (score > 0) scored.push({ ...ex, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Render the tool result: matched examples as fenced code blocks, or the grouped index when no query. */
export function renderExamplesResult(
  examples: readonly Example[],
  query: string | undefined,
  limit: number,
): string {
  if (query === undefined || query.trim() === "") {
    const byTopic = new Map<string, string[]>()
    for (const ex of examples) {
      const list = byTopic.get(ex.topic) ?? []
      list.push(ex.name)
      byTopic.set(ex.topic, list)
    }
    const index = [...byTopic.entries()]
      .map(([topic, names]) => `- **${topic}**: ${names.join(", ")}`)
      .join("\n")
    return `# nifra examples — index (${examples.length} verified snippets; pass \`query\` to fetch code)\n\nEvery snippet is typechecked against the installed nifra version — prefer these over recalling an API.\n\n${index}`
  }
  const matches = searchExamples(examples, query, limit)
  if (matches.length === 0) {
    return `No examples matched ${JSON.stringify(query)}. Call without a query for the index, or try a broader term (e.g. "auth", "upload", "isr", "client").`
  }
  return matches
    .map((m) => `## ${m.name} — ${m.topic}\n\n\`\`\`ts\n${m.code}\n\`\`\``)
    .join("\n\n---\n\n")
}

/** Load the bundled example corpus. Resolves relative to this module so it works from `src/` (repo dev)
 * and `dist/` (published) alike — `docs/examples.json` sits at the package root next to both. */
export async function loadExamplesCorpus(): Promise<Example[] | undefined> {
  const url = new URL("../docs/examples.json", import.meta.url)
  try {
    const text = await Bun.file(url).text()
    if (text.length === 0) return undefined
    const parsed = JSON.parse(text) as Example[]
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}
