const abortedAt: number[] = []
const shellVariations: Readonly<Record<string, string>> = {}
const tagUrls: string[] = []

/** Server-side counters the browser checks read through `/__probe`. One process, one test run. */
export const probe = {
  slowStarted: 0,
  slowAborted: 0,
  abortedAt,
  shellBuilds: 0,
  priceBuilds: 0,
  cancels: 0,
  shellOrigin: "",
  shellVariations,
  tagUrls,
}

const abortWaiters: Array<() => void> = []

/** Resolves at the next slow-hole abort, for in-process tests. */
export const nextSlowAbort = (): Promise<void> =>
  new Promise((resolve) => {
    abortWaiters.push(resolve)
  })

export const noteSlowAbort = (): void => {
  probe.slowAborted++
  probe.abortedAt.push(performance.now())
  for (const resolve of abortWaiters.splice(0)) resolve()
}

const holds: Array<() => void> = []

/** Resolves once `releaseHeld` runs; a browser check holds a hole to fill it after hydration. */
export const holdHole = (): Promise<void> =>
  new Promise((resolve) => {
    holds.push(resolve)
  })

export const releaseHeld = (): number => {
  const released = holds.splice(0)
  for (const resolve of released) resolve()
  return released.length
}
