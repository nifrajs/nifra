import type { Clock } from "../src/index.ts"

export function virtualClock(
  onSleep?: (elapsed: number) => void,
): Clock & { readonly elapsed: () => number; advance(ms: number): void } {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms
      onSleep?.(t)
    },
    elapsed: () => t,
    advance(ms) {
      t += ms
    },
  }
}
