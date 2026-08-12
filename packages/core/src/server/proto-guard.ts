/**
 * Prototype-poisoning guard for the JSON body lane - the Fastify-style two-tier check behind
 * `c.boundedJson` and the schema path. Tier 1 is a substring pre-scan of the raw text; only when a
 * suspect token *could* be present does tier 2 deep-walk the parsed value. Clean payloads - the
 * overwhelmingly common case - pay three linear `includes()` scans over a string already in memory
 * and nothing else: no reviver (a reviver taxes every key of every parse), no unconditional walk.
 *
 * Soundness of the pre-scan: `JSON.parse` can only produce an own key `__proto__` (or
 * `constructor`) if the raw text contains the quoted name verbatim, or spells part of it with
 * `\uXXXX` string escapes - the only JSON escape mechanism that can produce identifier
 * characters. Any `\u` in the text therefore also routes to the walk, so an escaped
 * `{"__proto__": ...}` cannot slip past the substring miss.
 */

export type ProtoPoisoning = "reject" | "strip" | "ignore"

const QUOTED_PROTO = '"__proto__"'
const QUOTED_CONSTRUCTOR = '"constructor"'
const UNICODE_ESCAPE = "\\u"

/** Thrown (as a reused singleton - never surfaced, always mapped to a flat 400) on `"reject"`. */
const POISONED = new Error("json_proto_poisoning")

/**
 * `JSON.parse` + the poisoning policy. Returns the parsed value (stripped in place under
 * `"strip"`); throws on invalid JSON or - via the same catch path - on a rejected poisoning, so
 * a poisoned payload is indistinguishable from malformed JSON to the caller.
 */
export function parseJsonGuarded(text: string, policy: ProtoPoisoning): unknown {
  return guardDecodedValue(text, JSON.parse(text), policy)
}

/**
 * The two-tier check on an already-decoded value plus the raw text it came from - for lanes that
 * parse with their own decoder (transport codecs) but still owe the same poisoning policy. Throws
 * the reject singleton; callers map it to their lane's flat error.
 */
export function guardDecodedValue(text: string, value: unknown, policy: ProtoPoisoning): unknown {
  if (policy === "ignore") return value
  if (
    !text.includes(QUOTED_PROTO) &&
    !text.includes(QUOTED_CONSTRUCTOR) &&
    !text.includes(UNICODE_ESCAPE)
  ) {
    return value
  }
  return sweep(value, policy)
}

/**
 * The guard for lanes that never see the raw text (the native-`json()` fast path): the walk runs
 * directly on the parsed value. No pre-scan is needed for soundness - string escapes are resolved
 * by the time a key is an own property, so a `\u`-spelled `__proto__` and a literal one look
 * identical here. Cost is one iterative pass over the value's nodes; `"ignore"` skips even that.
 */
export function guardParsedValue(value: unknown, policy: ProtoPoisoning): unknown {
  if (policy === "ignore") return value
  return sweep(value, policy)
}

/**
 * Tier 2: iterative deep-walk (adversarial nesting must not blow the call stack). An own key
 * `__proto__`, or an own `constructor` whose value carries an own `prototype`, is the poisoning
 * shape - `JSON.parse` creates these as plain data properties, and the blast radius is whatever
 * downstream merge/assign later copies them onto a real prototype. A string *value* of
 * `"__proto__"` is legal data and never triggers.
 */
/** Reused walk stack - `sweep` is synchronous and single-threaded, and a thrown rejection can
 * leave residue, so each entry clears it. Saves one array allocation per swept request. */
const STACK: unknown[] = []

function sweep(root: unknown, policy: "reject" | "strip"): unknown {
  const stack = STACK
  stack.length = 0
  stack.push(root)
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || typeof node !== "object") continue
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item)
      continue
    }
    const record = node as Record<string, unknown>
    // One pass, not two `Object.hasOwn` probes plus a walk: the suspect names are checked against
    // the keys the walk already enumerates, so a clean node pays two pointer-comparisons per key
    // instead of two hash lookups per node (measured ~30ns/request cheaper on a typical API body).
    // `for-in`, not `Object.keys()`: the keys array would be an allocation per node (~2x the whole
    // walk on measured bodies, both engines, at realistic widths; V8 only prefers `Object.keys` on
    // 200+-property dictionary-mode objects). On JSON.parse output the two enumerate identically -
    // own enumerable string keys, nothing enumerable on the prototype chain. A custom transport
    // codec could hand `guardDecodedValue` an object with enumerable INHERITED properties; `for-in`
    // sweeps those too, which only over-sweeps - a poisoned inherited subtree rejects rather than
    // slips through. A *non-enumerable* own `__proto__` is the one shape this misses, and it is
    // not the poisoning shape: `JSON.parse` never produces one, and the merges that carry the
    // payload onward (spread, `Object.assign`, key loops) copy enumerable own keys only.
    for (const key in record) {
      const value = record[key]
      if (key === "__proto__") {
        if (policy === "reject") throw POISONED
        // biome-ignore lint/complexity/useLiteralKeys: bracket access keeps the guarded key an explicit string, never a prototype walk
        delete record["__proto__"]
        continue
      }
      if (
        key === "constructor" &&
        value !== null &&
        typeof value === "object" &&
        Object.hasOwn(value, "prototype")
      ) {
        if (policy === "reject") throw POISONED
        // biome-ignore lint/complexity/useLiteralKeys: bracket access keeps the guarded key an explicit string, never a prototype walk
        delete record["constructor"]
        continue
      }
      stack.push(value)
    }
  }
  return root
}
