/** Code-unit order, the same on every runtime and in every locale. A file a project commits (a lock, a
 * generated SDK) sorts with this, so its bytes do not depend on the machine that wrote it. */
export function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
