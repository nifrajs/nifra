/** Escape every RegExp metacharacter so `value` matches literally inside a pattern. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
