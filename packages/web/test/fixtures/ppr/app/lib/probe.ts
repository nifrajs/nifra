const abortedAt: number[] = []

/** Server-side counters the browser checks read through `/__probe`. One process, one test run. */
export const probe = { slowStarted: 0, slowAborted: 0, abortedAt, shellBuilds: 0, cancels: 0 }
