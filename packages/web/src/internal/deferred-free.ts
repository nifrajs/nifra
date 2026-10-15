/**
 * Values an output guard settled under a schema that cannot let a `defer()` marker through: no
 * `t.deferred`, and no open or untyped node. `prepareDeferred` returns them without walking them.
 * A marker the schema does declare is projected into a new object, so the value that holds it is
 * a fresh copy, never one marked here.
 */
const deferredFree = new WeakSet<object>()

export function markDeferredFree(value: unknown): void {
  if (typeof value === "object" && value !== null) deferredFree.add(value)
}

export function isDeferredFree(value: unknown): boolean {
  return typeof value === "object" && value !== null && deferredFree.has(value)
}
