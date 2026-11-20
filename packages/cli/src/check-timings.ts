export interface CheckTimings {
  readonly totalMs: number
  /** Wall time per phase. Concurrent phases may overlap. */
  readonly phasesMs: Readonly<Record<string, number>>
}

export function createCheckTimer() {
  const began = performance.now()
  const phasesMs: Record<string, number> = {}
  const elapsed = (started: number): number => Math.round((performance.now() - started) * 100) / 100
  return {
    record(phase: string, started: number): void {
      phasesMs[phase] = elapsed(started)
    },
    async measure<T>(phase: string, run: () => T | Promise<T>): Promise<T> {
      const started = performance.now()
      try {
        return await run()
      } finally {
        phasesMs[phase] = elapsed(started)
      }
    },
    snapshot(): CheckTimings {
      return { totalMs: elapsed(began), phasesMs }
    },
  }
}
