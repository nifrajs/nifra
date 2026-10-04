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
 * The policy applied to an already-parsed JSON value - the native-`json()` lane, which never holds
 * the raw text. Escapes are resolved by the time a key is an own property, so a `\u`-spelled
 * `__proto__` and a literal one look identical here. Cost is one iterative pass over the value's
 * object nodes; `"ignore"` skips even that. The walk assumes a tree, which JSON always is; a
 * transport codec's output goes through {@link guardDecodedValue}. Throws the reject singleton;
 * callers map it to their lane's flat error.
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
    // own enumerable string keys, nothing enumerable on the prototype chain. Were a value with
    // enumerable INHERITED properties handed in, `for-in` would sweep those too, which only
    // over-sweeps - a poisoned inherited subtree rejects rather than slips through. A
    // *non-enumerable* own `__proto__` is the one shape this misses, and it is
    // not the poisoning shape: `JSON.parse` never produces one, and the merges that carry the
    // payload onward (spread, `Object.assign`, key loops) copy enumerable own keys only.
    for (const key in record) {
      const value = record[key]
      const nested = value !== null && typeof value === "object"
      // Keep the hot clean-key check branch-local and cheap. JSON keys are strings, and the length
      // + first-code-unit guards avoid a full string comparison for the overwhelming majority of
      // fields while preserving exact equality for the two security-sensitive names.
      if (key.length === 9 && key.charCodeAt(0) === 95 /* _ */ && key === "__proto__") {
        if (policy === "reject") throw POISONED
        // biome-ignore lint/complexity/useLiteralKeys: bracket access keeps the guarded key an explicit string, never a prototype walk
        delete record["__proto__"]
        continue
      }
      if (
        key.length === 11 &&
        key.charCodeAt(0) === 99 /* c */ &&
        key === "constructor" &&
        nested &&
        Object.hasOwn(value, "prototype")
      ) {
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

/** How many nodes shared references may add to a decoded value, counted as a tree walk visits it. */
const MAX_SHARED_EXPANSION = 100_000

/** Thrown (reused singleton, mapped like {@link POISONED}) for a decoded value no tree walk can finish,
 * or one holding a pattern the caller did not allow. */
const NOT_A_TREE = /* @__PURE__ */ new Error("decoded_value_not_a_tree")

/** Marks a node whose subtree is still being walked: meeting it again then is a cycle. */
const ON_PATH = -1

interface DecodedFrame {
  readonly node: object
  readonly children: readonly object[]
  next: number
  size: number
}

/**
 * The policy for a value a transport codec decoded. Unlike `JSON.parse` output that can be a graph -
 * a codec that keeps references, as the rich wire codec does, returns shared nodes and cycles - while
 * everything downstream (validators, handlers, serializers) walks a body as a tree. So a cycle is
 * refused, and shared nodes may add at most {@link MAX_SHARED_EXPANSION} nodes to the tree they expand
 * to: forty levels of doubled references fit in 2KB and expand to 2^40 paths. Map and Set members are
 * walked like properties. These shape rules hold under every policy, `"ignore"` included.
 *
 * A `RegExp` is refused unless `patterns` allows it: a pattern from the client is code, and one with
 * catastrophic backtracking stalls the event loop the moment anything runs it.
 */
export function guardDecodedValue(
  value: unknown,
  policy: ProtoPoisoning,
  patterns = false,
): unknown {
  if (value === null || typeof value !== "object") return value
  const sizes = new Map<object, number>()
  const frames: DecodedFrame[] = [openDecoded(value, policy, patterns, sizes)]
  let expanded = 0
  for (let frame = frames.at(-1); frame !== undefined; frame = frames.at(-1)) {
    const child = frame.children[frame.next]
    if (child !== undefined) {
      frame.next++
      const known = sizes.get(child)
      if (known === undefined) frames.push(openDecoded(child, policy, patterns, sizes))
      else if (known === ON_PATH) throw NOT_A_TREE
      else frame.size += known
      continue
    }
    frames.pop()
    sizes.set(frame.node, frame.size)
    const parent = frames.at(-1)
    if (parent === undefined) expanded = frame.size
    else parent.size += frame.size
  }
  if (expanded - sizes.size > MAX_SHARED_EXPANSION) throw NOT_A_TREE
  return value
}

function openDecoded(
  node: object,
  policy: ProtoPoisoning,
  patterns: boolean,
  sizes: Map<object, number>,
): DecodedFrame {
  if (!patterns && node instanceof RegExp) throw NOT_A_TREE
  sizes.set(node, ON_PATH)
  return { node, children: decodedChildren(node, policy), next: 0, size: 1 }
}

function decodedChildren(node: object, policy: ProtoPoisoning): object[] {
  const children: object[] = []
  const add = (value: unknown): void => {
    if (value !== null && typeof value === "object") children.push(value)
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) add(node[i])
    return children
  }
  if (node instanceof Map) {
    for (const [key, value] of node) {
      add(key)
      add(value)
    }
    return children
  }
  if (node instanceof Set) {
    for (const item of node) add(item)
    return children
  }
  // Binary and scalar wrappers carry no keys to poison; `for-in` over a typed array would enumerate
  // every index.
  if (
    ArrayBuffer.isView(node) ||
    node instanceof ArrayBuffer ||
    node instanceof Date ||
    node instanceof RegExp ||
    node instanceof URL
  ) {
    return children
  }
  for (const key in node) {
    const value: unknown = Reflect.get(node, key)
    if (
      policy !== "ignore" &&
      (key === "__proto__" ||
        (key === "constructor" &&
          value !== null &&
          typeof value === "object" &&
          Object.hasOwn(value, "prototype")))
    ) {
      if (policy === "reject") throw POISONED
      Reflect.deleteProperty(node, key)
      continue
    }
    add(value)
  }
  return children
}
