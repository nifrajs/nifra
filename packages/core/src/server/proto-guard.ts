/**
 * Prototype-poisoning guard for the JSON body lane - the check behind `c.boundedJson` and the
 * schema path. A single walk of the parsed value, never a reviver (a reviver taxes every key of
 * every parse, including the parses that carry no object at all).
 *
 * No raw-text pre-scan: the Fastify-style `text.includes('"__proto__"')` filter is a pessimization
 * on 2026 engines. A quoted-name search runs a general substring algorithm over the whole body,
 * while the walk only touches the nodes the parse already built. Measured on Node 26 and Bun 1.3,
 * three `includes()` calls cost 2-4x the walk on every body shape an API actually receives
 * (records, strings, nested objects); the scan only wins on a body that is mostly a flat array of
 * numbers, where it saves ~1.5us on a 9KB payload that spends 20us in `JSON.parse` regardless.
 * Dropping the tier also removes an escape-analysis obligation - the scan had to route every `\u`
 * to the walk, because `_` spells `_`.
 */

export type ProtoPoisoning = "reject" | "strip" | "ignore"

/** Thrown (as a reused singleton - never surfaced, always mapped to a flat 400) on `"reject"`. */
const POISONED = new Error("json_proto_poisoning")

/**
 * `JSON.parse` + the poisoning policy. Returns the parsed value (stripped in place under
 * `"strip"`); throws on invalid JSON or - via the same catch path - on a rejected poisoning, so
 * a poisoned payload is indistinguishable from malformed JSON to the caller.
 */
export function parseJsonGuarded(text: string, policy: ProtoPoisoning): unknown {
  return guardParsedValue(JSON.parse(text), policy)
}

/**
 * The policy applied to an already-parsed value - the native-`json()` lane, which never holds the
 * raw text, and the transport codecs, which parse with their own decoder. Escapes are resolved by
 * the time a key is an own property, so a `\u`-spelled `__proto__` and a literal one look identical
 * here. Cost is one iterative pass over the value's object nodes; `"ignore"` skips even that.
 * Throws the reject singleton; callers map it to their lane's flat error.
 */
export function guardParsedValue(value: unknown, policy: ProtoPoisoning): unknown {
  if (policy === "ignore") return value
  return sweep(value, policy)
}

/**
 * Iterative deep-walk (adversarial nesting must not blow the call stack). An own key
 * `__proto__`, or an own `constructor` whose value carries an own `prototype`, is the poisoning
 * shape - `JSON.parse` creates these as plain data properties, and the blast radius is whatever
 * downstream merge/assign later copies them onto a real prototype. A string *value* of
 * `"__proto__"` is legal data and never triggers.
 */
/** Reused walk stack - `sweep` is synchronous and single-threaded, and a thrown rejection can
 * leave residue, so each entry clears it. Saves one array allocation per swept request. */
const STACK: unknown[] = []

function sweep(root: unknown, policy: "reject" | "strip"): unknown {
  if (root === null || typeof root !== "object") return root
  const stack = STACK
  stack.length = 0
  stack.push(root)
  while (stack.length > 0) {
    const node = stack.pop() as object
    if (Array.isArray(node)) {
      // Only objects are stacked, here and below: a scalar carries no keys, so pushing it just to
      // pop and type-test it is pure stack traffic. Filtering at the push site measured 1.5-3x
      // faster on every body shape, both engines - the win grows with how scalar-heavy the body is.
      //
      // Indexed, not `for...of`: JSC allocates an array iterator per loop and calls `next()` per
      // element, and it does not escape either. Measured on Bun 1.3 the iterator form costs 4x on
      // an array of records, 8x on strings, and 12x on numbers - a 9KB numeric body walked in 27us
      // instead of 2.2us, which at the 1MB default cap is milliseconds of CPU an attacker picks.
      // V8 optimizes the iterator away, so on Node the two forms measure identical; the indexed
      // loop is simply the form that is fast on both.
      for (let i = 0; i < node.length; i++) {
        const item = node[i]
        if (item !== null && typeof item === "object") stack.push(item)
      }
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
    // codec could hand `guardParsedValue` an object with enumerable INHERITED properties; `for-in`
    // sweeps those too, which only over-sweeps - a poisoned inherited subtree rejects rather than
    // slips through. A *non-enumerable* own `__proto__` is the one shape this misses, and it is
    // not the poisoning shape: `JSON.parse` never produces one, and the merges that carry the
    // payload onward (spread, `Object.assign`, key loops) copy enumerable own keys only.
    for (const key in record) {
      const value = record[key]
      const nested = value !== null && typeof value === "object"
      if (key === "__proto__") {
        if (policy === "reject") throw POISONED
        // biome-ignore lint/complexity/useLiteralKeys: bracket access keeps the guarded key an explicit string, never a prototype walk
        delete record["__proto__"]
        continue
      }
      if (key === "constructor" && nested && Object.hasOwn(value, "prototype")) {
        if (policy === "reject") throw POISONED
        // biome-ignore lint/complexity/useLiteralKeys: bracket access keeps the guarded key an explicit string, never a prototype walk
        delete record["constructor"]
        continue
      }
      if (nested) stack.push(value)
    }
  }
  return root
}
