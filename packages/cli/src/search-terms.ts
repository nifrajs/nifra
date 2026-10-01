/**
 * Tiny deterministic query expansion for the agent-facing docs/example search tools.
 *
 * This is intentionally not "semantic search": the corpora are small, curated, and bundled with the
 * package. A few framework-specific aliases plus safe prefix matching cover the common human/agent
 * wording drift ("authentication" vs "auth", "ws" vs "websocket") without adding dependencies,
 * model calls, or nondeterministic ranking.
 */

export interface SearchTermGroup {
  readonly term: string
  readonly variants: readonly string[]
}

const ALIASES: Readonly<Record<string, readonly string[]>> = {
  action: ["actions"],
  actions: ["action"],
  api: ["backend", "server"],
  auth: ["authentication", "login", "session", "sessions"],
  authentication: ["auth", "login", "session", "sessions"],
  backend: ["api", "server"],
  cache: ["caching", "isr"],
  caching: ["cache", "isr"],
  client: ["typed"],
  cookie: ["cookies", "session", "sessions"],
  deploy: ["deployment", "edge", "worker", "workers", "vercel", "deno"],
  deployment: ["deploy", "edge", "worker", "workers", "vercel", "deno"],
  loader: ["loaders"],
  loaders: ["loader"],
  route: ["routes", "routing"],
  routes: ["route", "routing"],
  schema: ["schemas", "validation", "validate"],
  schemas: ["schema", "validation", "validate"],
  server: ["api", "backend"],
  session: ["sessions", "auth", "authentication", "cookie", "cookies"],
  sessions: ["session", "auth", "authentication", "cookie", "cookies"],
  sse: ["eventsource", "stream", "streams"],
  typed: ["client", "type", "types"],
  upload: ["uploads", "file"],
  uploads: ["upload", "file"],
  validate: ["validation", "schema", "schemas"],
  validation: ["validate", "schema", "schemas"],
  websocket: ["websockets", "ws"],
  websockets: ["websocket", "ws"],
  ws: ["websocket", "websockets"],
}

export const MAX_QUERY_CHARS = 256
export const MAX_QUERY_TERMS = 12

export const tokenize = (s: string): string[] =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)

export function queryTermGroups(query: string): SearchTermGroup[] {
  return [...new Set(tokenize(query.slice(0, MAX_QUERY_CHARS)))]
    .slice(0, MAX_QUERY_TERMS)
    .map((term) => ({
      term,
      variants: [term, ...(ALIASES[term] ?? [])],
    }))
}

function tokenMatches(term: string, candidate: string): boolean {
  if (term === candidate) return true
  // Prefix matching catches plural/stem variants without letting very short terms get noisy.
  return (
    term.length >= 4 &&
    candidate.length >= 4 &&
    (term.startsWith(candidate) || candidate.startsWith(term))
  )
}

export function tokenSetHas(tokens: ReadonlySet<string>, group: SearchTermGroup): boolean {
  return tokenSetScore(tokens, group) > 0
}

/** Score the strongest name/heading match while keeping exact query words ahead of aliases. */
export function tokenSetScore(tokens: ReadonlySet<string>, group: SearchTermGroup): number {
  let best = 0
  for (const variant of group.variants) {
    for (const candidate of tokens) {
      if (!tokenMatches(variant, candidate)) continue
      const score =
        variant === group.term && candidate === variant ? 3 : candidate === variant ? 2 : 1
      if (score > best) best = score
    }
  }
  return best
}

export function countBodyHits(lowerBody: string, group: SearchTermGroup, maxHits: number): number {
  let best = 0
  for (const variant of group.variants) {
    let from = 0
    let hits = 0
    while (hits < maxHits) {
      const at = lowerBody.indexOf(variant, from)
      if (at === -1) break
      hits++
      from = at + variant.length
    }
    if (hits > best) best = hits
  }
  return best
}
