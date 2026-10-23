const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype

/**
 * Structural sharing for reloaded route data: the result equals `next`, but every part of it equal to
 * the same place in `prev` is `prev`'s own object, and it is `prev` itself when nothing changed. A
 * reload then keeps the identity of what it did not change, so a renderer keyed on identity (Solid's
 * `<For>`, a memoized row, a Vue child component) leaves those parts as they are on screen.
 *
 * Plain objects and arrays compare by content and Dates by time (a revived `t.date()` field is a new
 * `Date` on every parse); anything else, such as a class instance, a `Map`, a promise or an object
 * without a prototype, is taken from `next`. An array element with an `id` pairs with the old element of that `id` before the one at its
 * index, so a prepend or a reorder still keeps every unchanged row. An array whose first 32 elements
 * keep nothing is taken from `next` whole: a reload that changed every row stops walking early.
 */
export function shareData<T>(prev: unknown, next: T): T
export function shareData(prev: unknown, next: unknown): unknown {
  if (Object.is(prev, next)) return prev
  if (prev instanceof Date && next instanceof Date)
    return prev.getTime() === next.getTime() ? prev : next
  if (Array.isArray(prev) && Array.isArray(next)) {
    const out: unknown[] = []
    let same = prev.length === next.length
    let byId: Map<unknown, unknown> | undefined
    let kept = 0
    for (let i = 0; i < next.length; i++) {
      const item: unknown = next[i]
      let old: unknown = prev[i]
      const id = isPlain(item) ? item.id : undefined
      if (id !== undefined && !(isPlain(old) && old.id === id)) {
        if (byId === undefined) {
          byId = new Map()
          for (const entry of prev) if (isPlain(entry)) byId.set(entry.id, entry)
        }
        old = byId.get(id)
      }
      const value = shareData(old, item)
      out.push(value)
      if (value === old) kept++
      else if (i === 31 && kept === 0) return next
      if (value !== prev[i]) same = false
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
      const value = shareData(old, next[key])
      // A missing key reads `undefined` too.
      if (value !== old || (old === undefined && !Object.hasOwn(prev, key))) same = false
      out[key] = value
    }
    return same ? prev : out
  }
  return next
}
