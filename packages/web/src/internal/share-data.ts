const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype

const TOO_DEEP = Symbol("data too deep")

// Client loaders may return graphs, unlike JSON. Check the whole graph before comparing: a cycle
// inside a new subtree or beyond the array sample must not acquire copied parents. Shared references
// and accessors also keep the fresh result intact, rather than changing aliases or invoking getters.
function isTree(value: unknown, seen: Set<object>, depth: number): boolean {
  if (!Array.isArray(value) && !isPlain(value)) return true
  if (depth >= 128 || seen.has(value)) return false
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (
      field === undefined ||
      !("value" in field) ||
      (!field.enumerable && !(Array.isArray(value) && key === "length")) ||
      !isTree(field.value, seen, depth + 1)
    )
      return false
  }
  return true
}

/**
 * Structural sharing for reloaded route data. Plain objects and arrays compare by content and Dates
 * by time; other values and symbol-bearing objects come from `next`. Non-tree client data stays
 * intact. `plainJson` is only for freshly parsed JSON, before any client-loader transformation.
 *
 * Array elements with an `id` pair by it before position, preserving unchanged rows on a prepend or
 * reorder. An array whose first 32 elements keep nothing is taken whole, without a full old-row index.
 */
export function shareData<T>(prev: unknown, next: T, plainJson?: boolean): T
export function shareData(prev: unknown, next: unknown, plainJson = false): unknown {
  if (Object.is(prev, next)) return prev
  if (!plainJson && !isTree(next, new Set(), 0)) return next
  try {
    return share(prev, next, 0)
  } catch (error) {
    if (error === TOO_DEEP) return next
    throw error
  }
}

function share(prev: unknown, next: unknown, depth: number): unknown {
  if (Object.is(prev, next)) return prev
  if (prev instanceof Date && next instanceof Date)
    return prev.getTime() === next.getTime() ? prev : next
  if (!(Array.isArray(prev) && Array.isArray(next)) && !(isPlain(prev) && isPlain(next)))
    return next
  // Client loaders can attach metadata that an enumerable-string-key copy would lose.
  if (
    Object.getOwnPropertySymbols(prev).length > 0 ||
    Object.getOwnPropertySymbols(next).length > 0
  )
    return next
  if (depth >= 128) throw TOO_DEEP
  if (Array.isArray(prev) && Array.isArray(next)) {
    const out: unknown[] = []
    let same = prev.length === next.length
    let byId: Map<unknown, unknown> | undefined
    let completeIndex = false
    let kept = 0
    let i = 0
    for (const item of next) {
      let old: unknown = prev[i]
      const id = isPlain(item) ? item.id : undefined
      if (id !== undefined && !(isPlain(old) && old.id === id)) {
        if (byId === undefined || (i >= 32 && !completeIndex)) {
          // Index only IDs needed by the sample until a kept row makes a full index worthwhile.
          const wanted =
            i < 32
              ? new Set(next.slice(0, 32).map((value) => (isPlain(value) ? value.id : undefined)))
              : undefined
          completeIndex = wanted === undefined
          let min = Number.POSITIVE_INFINITY
          let max = Number.NEGATIVE_INFINITY
          for (const key of wanted ?? []) {
            if (typeof key !== "number" || Number.isNaN(key)) {
              min = Number.NEGATIVE_INFINITY
              max = Number.POSITIVE_INFINITY
              break
            }
            min = Math.min(min, key)
            max = Math.max(max, key)
          }
          byId = new Map()
          for (const entry of prev) {
            if (!isPlain(entry)) continue
            const entryId = entry.id
            if (
              wanted === undefined ||
              ((typeof entryId !== "number" || !(entryId < min || entryId > max)) &&
                wanted.has(entryId))
            )
              byId.set(entryId, entry)
          }
        }
        old = byId.get(id)
      }
      const value = share(old, item, depth + 1)
      out.push(value)
      if (value === old) kept++
      else if (i === 31 && kept === 0) return next
      if (value !== prev[i]) same = false
      i++
    }
    return same ? prev : out
  }
  if (isPlain(prev) && isPlain(next)) {
    const keys = Object.keys(next)
    let same = keys.length === Object.keys(prev).length
    const out: Record<string, unknown> = {}
    for (const key of keys) {
      // A parsed payload can own a `__proto__` key, which a copy would turn into its prototype.
      if (key === "__proto__") return next
      const old = prev[key]
      const value = share(old, next[key], depth + 1)
      if (value !== old || (old === undefined && !Object.hasOwn(prev, key))) same = false
      out[key] = value
    }
    return same ? prev : out
  }
  return next
}
