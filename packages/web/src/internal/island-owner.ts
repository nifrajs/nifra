// The disposer list of the island whose enhancer is running, so every effect, computed, list binding
// and resource it creates stops when the island unmounts. A separate module so an imperative-only
// island bundle carries no signal code.
let owner: Array<() => void> | undefined

/** Run `fn` with every disposer it registers pushed onto `kids`. */
export function owned<T>(kids: Array<() => void>, fn: () => T): T {
  const prev = owner
  owner = kids
  try {
    return fn()
  } finally {
    owner = prev
  }
}

/** Register `stop` with the running island, if any. Outside an enhancer it stays the caller's. */
export function adopt(stop: () => void): void {
  owner?.push(stop)
}
