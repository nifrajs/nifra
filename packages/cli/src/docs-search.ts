/**
 * `nifra_docs` - searchable framework documentation for agents. The corpus is the generated
 * `llms-full.txt` (written into this package by `bun run gen:llms`, so it can't drift from the
 * source it's generated from). Instead of dumping the whole ~150 KB into an agent's context, the
 * tool keyword-scores the document's `##` sections and returns only the top matches - or, with no
 * query, just the section index (the cheap discovery call).
 *
 * Deliberately NOT a vector search: the corpus is one curated document with descriptive headings;
 * weighted keyword scoring over sections is deterministic, dependency-free, and good enough that
 * embedding infra would be complexity without a payoff.
 */

import { countBodyHits, queryTermGroups, tokenize, tokenSetHas } from "./search-terms.ts"

export interface DocSection {
  readonly heading: string
  readonly body: string
}

export interface PreparedDocSection extends DocSection {
  readonly headingTokens: ReadonlySet<string>
  readonly bodyLower: string
}

const sectionCache = new Map<string, readonly PreparedDocSection[]>()

/** Split the generated doc into its `##` sections (the `# title` intro becomes "Overview"). */
export function splitSections(markdown: string): DocSection[] {
  const out: DocSection[] = []
  const lines = markdown.split("\n")
  let heading = "Overview"
  let buf: string[] = []
  const flush = (): void => {
    const body = buf.join("\n").trim()
    if (body.length > 0) out.push({ heading, body })
    buf = []
  }
  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush()
      heading = line.slice(3).trim()
    } else {
      buf.push(line)
    }
  }
  flush()
  return out
}

function prepareSection(section: DocSection): PreparedDocSection {
  return {
    ...section,
    headingTokens: new Set(tokenize(section.heading)),
    bodyLower: section.body.toLowerCase(),
  }
}

/** Return the immutable-build section parse and derived search fields from the process cache. */
export function getCachedDocSections(markdown: string): readonly PreparedDocSection[] {
  const cached = sectionCache.get(markdown)
  if (cached !== undefined) return cached
  const prepared = splitSections(markdown).map(prepareSection)
  sectionCache.set(markdown, prepared)
  return prepared
}

export interface ScoredSection extends DocSection {
  readonly score: number
}

/** Score sections against the query: a term in the HEADING is worth far more than body mentions
 * (headings are curated names for exactly these lookups); body occurrences cap per term so one
 * spammy section can't drown a precisely-titled one. */
export function searchSections(
  sections: readonly (DocSection | PreparedDocSection)[],
  query: string,
  limit: number,
): ScoredSection[] {
  const terms = queryTermGroups(query)
  if (terms.length === 0) return []
  const scored: ScoredSection[] = []
  for (const section of sections) {
    const prepared =
      "headingTokens" in section && "bodyLower" in section ? section : prepareSection(section)
    let score = 0
    for (const term of terms) {
      if (tokenSetHas(prepared.headingTokens, term)) score += 8
      score += countBodyHits(prepared.bodyLower, term, 5)
    }
    if (score > 0) scored.push({ heading: section.heading, body: section.body, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Cap a section body for the tool result - whole sections can be pages long; the agent can ask
 * again with a narrower query if the trim cuts what it needed. */
const MAX_SECTION_CHARS = 2800

/** Render the tool result: matched sections, or the index when no query was given. */
export function renderDocsResult(
  markdown: string,
  query: string | undefined,
  limit: number,
): string {
  const sections = getCachedDocSections(markdown)
  if (query === undefined || query.trim() === "") {
    const index = sections.map((s) => `- ${s.heading}`).join("\n")
    return `# nifra docs - section index (pass \`query\` to fetch matching sections)\n\n${index}`
  }
  const matches = searchSections(sections, query, limit)
  if (matches.length === 0) {
    return `No docs sections matched ${JSON.stringify(query)}. Call without a query for the section index.`
  }
  return matches
    .map((m) => {
      const body =
        m.body.length > MAX_SECTION_CHARS
          ? `${m.body.slice(0, MAX_SECTION_CHARS)}\n…(trimmed - narrow the query for the rest)`
          : m.body
      return `## ${m.heading}\n\n${body}`
    })
    .join("\n\n---\n\n")
}

/** Load the bundled corpus. Resolves relative to this module so it works from `src/` (repo dev)
 * and `dist/` (published) alike - `docs/llms-full.txt` sits at the package root next to both. */
let docsCorpusPromise: Promise<string | undefined> | undefined

/** The published corpus is immutable, so one read and one parsed-section cache are sufficient. */
export function loadDocsCorpus(): Promise<string | undefined> {
  docsCorpusPromise ??= (async () => {
    const url = new URL("../docs/llms-full.txt", import.meta.url)
    try {
      const text = await Bun.file(url).text()
      return text.length > 0 ? text : undefined
    } catch {
      return undefined
    }
  })()
  return docsCorpusPromise
}
