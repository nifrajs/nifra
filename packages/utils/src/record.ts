/** A non-null, non-array object; its prototype is not restricted. */
// biome-ignore lint/plugin/noHelperCopy: canonical implementation owned by @nifrajs/utils.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
