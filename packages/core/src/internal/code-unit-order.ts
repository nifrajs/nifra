/**
 * Code-unit order, the same on every runtime and in every locale. `localeCompare` answers by the
 * runtime's locale and ICU data, so an artifact that is hashed, signed, or committed sorts with this
 * instead: its bytes must not depend on the machine that built it.
 */
export function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
