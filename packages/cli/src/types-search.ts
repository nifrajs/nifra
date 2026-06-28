/**
 * `nifra_types` — the EXACT TypeScript of every exported `@nifrajs/*` symbol. The corpus is `types.json`
 * (written into this package by `bun run gen:llms`): each entry's `signature` is the literal declaration
 * parsed from the package's BUILT `.d.ts` with the TS compiler — a clean signature, never prose, never
 * truncated. So an agent that needs the precise shape of a type (`RateLimitStore`, `RouteSchema`, a
 * function signature) gets the authoritative source here and never has to read a `.d.ts` file.
 *
 * Lookup by `name` is exact (case-insensitive); `query` keyword-scores over the name (heavy) + the
 * signature/doc body; no args → a per-package index of the available type names.
 */

import { countBodyHits, queryTermGroups, tokenize, tokenSetHas } from "./search-terms.ts"

export interface TypeEntry {
  readonly name: string
  readonly kind: "interface" | "type" | "class" | "function" | "enum" | "const"
  readonly package: string
  /** The literal declaration text from the `.d.ts` — a clean signature, no implementation. */
  readonly signature: string
  /** The declaration's JSDoc block, if any. */
  readonly doc?: string
}

export interface ScoredType extends TypeEntry {
  readonly score: number
}

/** Exact (case-insensitive) name lookup — returns every declaration with that name (a name can exist in
 * more than one package). */
export function lookupType(types: readonly TypeEntry[], name: string): TypeEntry[] {
  const wanted = name.trim().toLowerCase()
  return types.filter((t) => t.name.toLowerCase() === wanted)
}

/** Keyword-score types: a term in the name is worth far more than one in the signature/doc body. */
export function searchTypes(
  types: readonly TypeEntry[],
  query: string,
  limit: number,
): ScoredType[] {
  const terms = queryTermGroups(query)
  if (terms.length === 0) return []
  const scored: ScoredType[] = []
  for (const t of types) {
    const nameTokens = new Set(tokenize(t.name))
    const body = `${t.signature} ${t.doc ?? ""}`.toLowerCase()
    let score = 0
    for (const term of terms) {
      if (tokenSetHas(nameTokens, term)) score += 8
      score += countBodyHits(body, term, 4)
    }
    if (score > 0) scored.push({ ...t, score })
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit)
}

function renderEntry(t: TypeEntry): string {
  const head = `## ${t.name} — ${t.kind}, \`${t.package}\``
  const doc = t.doc ? `${t.doc}\n` : ""
  return `${head}\n\n\`\`\`ts\n${doc}${t.signature}\n\`\`\``
}

/**
 * Render the tool result. `name` → the exact declaration(s); else `query` → the top matches; else a
 * per-package index of type names. The signatures are authoritative (generated from the built `.d.ts`),
 * so this is the complete answer — there is no need to read a `.d.ts` file.
 */
export function renderTypesResult(
  types: readonly TypeEntry[],
  name: string | undefined,
  query: string | undefined,
  limit: number,
): string {
  if (name !== undefined && name.trim() !== "") {
    const hits = lookupType(types, name)
    if (hits.length === 0) {
      return `No exported type named ${JSON.stringify(name)} in @nifrajs/*. Call nifra_types with a \`query\` (e.g. "rate limit") or no args for the per-package index of names.`
    }
    return hits.map(renderEntry).join("\n\n---\n\n")
  }
  if (query !== undefined && query.trim() !== "") {
    const matches = searchTypes(types, query, limit)
    if (matches.length === 0) {
      return `No types matched ${JSON.stringify(query)}. Try a broader term, pass an exact \`name\`, or call with no args for the index.`
    }
    return matches.map(renderEntry).join("\n\n---\n\n")
  }
  const byPkg = new Map<string, string[]>()
  for (const t of types) {
    const list = byPkg.get(t.package) ?? []
    list.push(t.name)
    byPkg.set(t.package, list)
  }
  const index = [...byPkg.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, names]) => `- **${pkg}**: ${names.sort().join(", ")}`)
    .join("\n")
  return `# nifra types — index (${types.length} exported symbols; pass \`name\` for the exact declaration, or \`query\` to search)\n\nSignatures are generated from the built \`.d.ts\` — authoritative + complete. Use this instead of reading any \`.d.ts\` file.\n\n${index}`
}

/** Load the bundled type corpus (`docs/types.json`), resolved relative to this module so it works from
 * `src/` (dev) and `dist/` (published) alike. */
export async function loadTypesCorpus(): Promise<TypeEntry[] | undefined> {
  const url = new URL("../docs/types.json", import.meta.url)
  try {
    const text = await Bun.file(url).text()
    if (text.length === 0) return undefined
    const parsed = JSON.parse(text) as TypeEntry[]
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}
