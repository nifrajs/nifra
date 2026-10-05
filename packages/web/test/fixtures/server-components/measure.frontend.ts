import type { ComponentClientAdapter } from "@nifrajs/web/server-components/client"
export function measureComponentAdapter(native: ComponentClientAdapter) {
  const timings: { prepare: number[]; commit: number[]; firstPrepareMs: number } = {
    prepare: [],
    commit: [],
    firstPrepareMs: 0,
  }
  const adapter: ComponentClientAdapter = {
    ...native,
    async prepare(...args) {
      const start = performance.now()
      const result = await native.prepare(...args)
      const elapsed = performance.now() - start
      if (timings.firstPrepareMs === 0) timings.firstPrepareMs = elapsed
      timings.prepare.push(elapsed)
      return result
    },
    async update(...args) {
      const start = performance.now()
      await native.update(...args)
      timings.commit.push(performance.now() - start)
    },
  }
  return { adapter, timings }
}
