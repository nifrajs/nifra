const abortedAt: number[] = []

/** Server-side counters the browser checks read through `/__probe`. One process, one test run. */
export const probe = { slowStarted: 0, slowAborted: 0, abortedAt, shellBuilds: 0, cancels: 0 }

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
