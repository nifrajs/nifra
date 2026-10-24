import { t } from "@nifrajs/schema"
import { noteSlowAbort } from "../../../app/lib/probe.ts"
import { visitorName } from "../../../app/lib/session.ts"

export const shellLoader = (ctx: { readonly params: Readonly<Record<string, string>> }) => ({
  title: `Product ${ctx.params.id}`,
})
export const shellOutput = t.object({ title: t.string() })

const abortable = (signal: AbortSignal, ms: number): Promise<{ at: number }> =>
  new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      noteSlowAbort()
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve({ at: ms })
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })

export const boundaryLoaders = {
  greeting: {
    load: (ctx: { readonly request: Request }) => ({ name: visitorName(ctx.request) }),
    output: t.object({ name: t.string() }),
  },
  cart: { load: () => ({ count: 2 }), output: t.object({ count: t.number() }) },
  slow: {
    load: (ctx: { readonly request: Request; readonly signal: AbortSignal }) =>
      abortable(ctx.signal, Number(new URL(ctx.request.url).searchParams.get("slow") ?? "50")),
    output: t.object({ at: t.number() }),
  },
}
