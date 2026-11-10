/** A non-null, non-array object. The prototype is not checked: a `Date` or a `Map` passes. */
// biome-ignore lint/plugin/noHelperCopy: this is the e2e package's one owning module for isRecord.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
