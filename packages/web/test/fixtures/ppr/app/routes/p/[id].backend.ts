import { t } from "@nifrajs/schema"
import { probe } from "../../lib/probe.ts"
import { visitorName } from "../../lib/session.ts"

export const shellLoader = async (ctx: { readonly params: Readonly<Record<string, string>> }) => {
  probe.shellBuilds++
  return { title: `Product ${ctx.params.id}` }
}
export const shellOutput = t.object({ title: t.string() })

const abortable = (signal: AbortSignal, ms: number): Promise<{ at: number }> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ at: ms }), ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        probe.slowAborted++
        probe.abortedAt.push(performance.now())
        reject(signal.reason)
      },
      { once: true },
    )
  })

export const boundaryLoaders = {
  greeting: {
    load: (ctx: { readonly request: Request }) => ({ name: visitorName(ctx.request) }),
    output: t.object({ name: t.string() }),
  },
  cart: {
    load: () => ({ count: 2 }),
    output: t.object({ count: t.number() }),
  },
  slow: {
    load: (ctx: { readonly request: Request; readonly signal: AbortSignal }) => {
      probe.slowStarted++
      const ms = Number(new URL(ctx.request.url).searchParams.get("slow") ?? "50")
      return abortable(ctx.signal, ms)
    },
    output: t.object({ at: t.number() }),
  },
}
