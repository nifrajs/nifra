import { spyOn } from "bun:test"

/**
 * Characters `String#indexOf` examines while `run` executes: a deterministic stand-in for parse time,
 * so a scaling test needs no clock.
 */
export function indexOfScanned(run: () => void): number {
  const original = String.prototype.indexOf
  let scanned = 0
  const spy = spyOn(String.prototype, "indexOf").mockImplementation(function (
    this: string,
    search: string,
    from?: number,
  ) {
    const at = original.call(this, search, from)
    scanned += (at === -1 ? this.length : at) - Math.max(0, from ?? 0)
    return at
  })
  try {
    run()
  } finally {
    spy.mockRestore()
  }
  return scanned
}
