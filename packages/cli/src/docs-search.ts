/**
 * `nifra_docs` - searchable framework documentation for agents. The corpus is the generated
 * `llms-full.txt` (written into this package by `bun run gen:llms`, so it can't drift from the
 * source it's generated from). Instead of dumping the whole ~150 KB into an agent's context, the
 * tool keyword-scores the document's `##` sections and returns only the top matches - or, with no
 * query, just the section index (the cheap discovery call). A matched page too long to return whole
 * is narrowed to its `###` subsections that match, after the page's lead and before a list of the
 * rest, so the answer is the part asked about rather than the page's first screen.
 *
 * Deliberately NOT a vector search: the corpus is one curated document with descriptive headings;
 * weighted keyword scoring over sections is deterministic, dependency-free, and good enough that
 * embedding infra would be complexity without a payoff.
 */

import { countBodyHits, queryTermGroups, tokenize, tokenSetScore } from "./search-terms.ts"

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
    let matchedTerms = 0
    for (const term of terms) {
      const headingScore = tokenSetScore(prepared.headingTokens, term)
      if (headingScore > 0) score += 8 + headingScore * 12
      const bodyHits = countBodyHits(prepared.bodyLower, term, 5)
      if (headingScore > 0 || bodyHits > 0) matchedTerms += 1
      score += bodyHits
    }
    // A result that matches every query concept should beat a section that only happens to repeat
    // one highly frequent word, even when that single word appears in a curated heading.
    score += matchedTerms * 26
    if (score > 0) scored.push({ heading: section.heading, body: section.body, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Cap a section body for the tool result - whole sections can be pages long; the agent can ask
 * again with a narrower query if the trim cuts what it needed. */
const MAX_SECTION_CHARS = 2800
/** The page lead kept above its matched subsections: enough to say what the page is. */
const MAX_LEAD_CHARS = 600
/** The best subsection is the answer, so it may run past the section cap; a whole worked example fits. */
const MAX_SUBSECTION_CHARS = 6000

/** A page body's lead (before its first `###`) and its `###` subsections. Fenced code is skipped,
 * so a `###` line inside a snippet is not a heading. */
export function splitSubsections(body: string): { lead: string; parts: DocSection[] } {
  const parts: DocSection[] = []
  let lead = ""
  let heading: string | undefined
  let buf: string[] = []
  let fenced = false
  const flush = (): void => {
    const text = buf.join("\n").trim()
    if (heading === undefined) lead = text
    else parts.push({ heading, body: text })
    buf = []
  }
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced
    if (!fenced && line.startsWith("### ")) {
      flush()
      heading = line.slice(4).trim()
    } else {
      buf.push(line)
    }
  }
  flush()
  return { lead, parts }
}

function capped(text: string, max: number, note: string): string {
  return text.length > max ? `${text.slice(0, max)}\n…(${note})` : text
}

/** One matched page: whole when it fits, otherwise its lead, the subsections the query matches
 * (best first, at least one, within the size cap) and the headings of the others. */
function renderMatch(match: DocSection, query: string): string {
  if (match.body.length <= MAX_SECTION_CHARS) return `## ${match.heading}\n\n${match.body}`
  const { lead, parts } = splitSubsections(match.body)
  const ranked = parts.length === 0 ? [] : searchSections(parts, query, parts.length)
  if (ranked.length === 0) {
    const others =
      parts.length === 0
        ? ""
        : `\n\nSubsections: ${parts.map((part) => part.heading).join(" | ")} - query one by name for its text.`
    return `## ${match.heading}\n\n${capped(match.body, MAX_SECTION_CHARS, "trimmed - narrow the query for the rest")}${others}`
  }
  const shown: ScoredSection[] = []
  let used = 0
  for (const part of ranked) {
    if (
      shown.length > 0 &&
      (used + part.body.length > MAX_SECTION_CHARS || part.score * 2 < ranked[0]!.score)
    ) {
      break
    }
    shown.push(part)
    used += part.body.length
  }
  const shownHeadings = new Set(shown.map((part) => part.heading))
  const others = parts
    .filter((part) => !shownHeadings.has(part.heading))
    .map((part) => part.heading)
  const body = shown
    .map(
      (part, index) =>
        `### ${part.heading}\n\n${capped(part.body, index === 0 ? MAX_SUBSECTION_CHARS : MAX_SECTION_CHARS, "trimmed")}`,
    )
    .join("\n\n")
  const rest = others.length === 0 ? "" : `\n\nAlso on this page: ${others.join(" | ")}`
  return `## ${match.heading}\n\n${capped(lead, MAX_LEAD_CHARS, "lead trimmed")}\n\n${body}${rest}`
}

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
  return matches.map((match) => renderMatch(match, query)).join("\n\n---\n\n")
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
