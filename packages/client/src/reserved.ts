/**
 * The reserved typed-client proxy keys, in one place.
 *
 * The proxy resolves these names before it resolves a path segment, so a route whose path contains
 * a static segment spelling one of them is unreachable by property access. That is a real cost paid
 * by user route names, which makes this list a PUBLIC CONTRACT and not an implementation detail:
 *
 *   - The list is FROZEN. A name is never added to it. Growing it would break, at compile time,
 *     every consumer that happens to have a route segment with that name - which is exactly the
 *     break `subscribe`/`ws`/`index`/`then` caused once already. Anything the client gains from
 *     here on is reached through a `$`-prefixed key in {@link NAMESPACED_KEYS}, or a symbol. A path
 *     segment can spell a `$` key, so those are reported by the same lint, but no route is
 *     expected to.
 *   - Removing one is a breaking change too (a call site that uses the capability stops working),
 *     so this list only ever shrinks in a major.
 *
 * Three surfaces read it: the runtime proxy (`client.ts`), the compile-time rejection
 * (`treaty.ts` - `ReservedVerbKey`/`ReservedExactKey`, which must be the same names spelled as
 * types), and the `nifra check` lint plus `nifra routes` annotation in @nifrajs/cli. Lockstep is
 * asserted behaviorally in `test/reserved-lockstep.test.ts` rather than by comparing two lists:
 * the test drives the real proxy against real routes, so a key that stopped being intercepted
 * fails even if every list still agrees.
 */

/** Intercepted case-insensitively: `/api/Delete` collides just as `/api/delete` does. */
export const RESERVED_VERB_KEYS = Object.freeze([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
] as const)

/** Intercepted by exact match: `subscribe`/`ws` are transports, `index` is `/`, `then` is the await guard. */
export const RESERVED_EXACT_KEYS = Object.freeze(["subscribe", "ws", "index", "then"] as const)

/** Capabilities added after the lists above froze, intercepted by exact match. Only ever `$`-prefixed:
 * `$query` calls a route under the QUERY method, which has no plain verb key because `query` is a
 * common route segment. */
export const NAMESPACED_KEYS = Object.freeze(["$query"] as const)

/** Human-readable readout of the closed set, for diagnostics that have to teach it. */
export const RESERVED_KEY_READOUT = `${RESERVED_VERB_KEYS.join("/")} (any casing), ${[...RESERVED_EXACT_KEYS, ...NAMESPACED_KEYS].join(", ")}`

/**
 * The reserved key a static path segment collides with, or undefined. Params (`:id`) and wildcards
 * (`*rest`) never collide - they are not spelled as property accesses.
 */
export function reservedKeyFor(segment: string): string | undefined {
  if (segment.startsWith(":") || segment.startsWith("*")) return undefined
  if (listed(RESERVED_EXACT_KEYS, segment) || listed(NAMESPACED_KEYS, segment)) return segment
  const lower = segment.toLowerCase()
  return listed(RESERVED_VERB_KEYS, lower) ? lower : undefined
}

const listed = (keys: readonly string[], segment: string): boolean => keys.includes(segment)
