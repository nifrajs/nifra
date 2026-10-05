/** Code-unit order, the same on every runtime and in every locale. A build artifact or a report sorts
 * with this, so its bytes and its order do not depend on the machine that produced it. */
export function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
