import { availableParallelism, loadavg } from "node:os"

export interface PerformanceHost {
  readonly logicalCpus: number
  readonly load: number
}

/** Contended wall-clock timings cannot establish a regression or an improvement. */
export function performanceHost(requireIdle: boolean): PerformanceHost {
  const logicalCpus = availableParallelism()
  const load = loadavg()[0] ?? Number.POSITIVE_INFINITY
  if (requireIdle && load > logicalCpus / 2)
    throw new Error(
      `benchmark host is busy: load ${load.toFixed(1)} exceeds ${logicalCpus / 2}; no performance proof recorded`,
    )
  return { logicalCpus, load }
}
