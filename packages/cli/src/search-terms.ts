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

export const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)

export function queryTermGroups(query: string): SearchTermGroup[] {
  return [...new Set(tokenize(query))].map((term) => ({
    term,
    variants: [term, ...(ALIASES[term] ?? [])],
  }))
}

function tokenMatches(term: string, token: string): boolean {
  if (term === token) return true
  // Prefix matching catches plural/stem variants without letting very short terms get noisy.
  return term.length >= 4 && token.length >= 4 && (term.startsWith(token) || token.startsWith(term))
}

export function tokenSetHas(tokens: ReadonlySet<string>, group: SearchTermGroup): boolean {
  for (const variant of group.variants) {
    for (const token of tokens) {
      if (tokenMatches(variant, token)) return true
    }
  }
  return false
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
