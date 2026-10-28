/** Escape every RegExp metacharacter so `value` matches literally inside a pattern. */
// biome-ignore lint/plugin/noHelperCopy: canonical implementation owned by @nifrajs/utils.
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
