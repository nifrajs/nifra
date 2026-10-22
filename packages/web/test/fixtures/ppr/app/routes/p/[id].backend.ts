import { t } from "@nifrajs/schema"
import { notFound } from "../../../../../../src/internal/render-document.ts"
import { holdHole, noteSlowAbort, probe } from "../../lib/probe.ts"
import { visitorName } from "../../lib/session.ts"

export const shellLoader = async (ctx: {
  readonly params: Readonly<Record<string, string>>
  readonly origin?: string
  readonly variations: Readonly<Record<string, string>>
}) => {
  probe.shellBuilds++
  probe.shellOrigin = ctx.origin ?? ""
  probe.shellVariations = ctx.variations
  if (ctx.params.id === "missing") notFound()
  return { title: `Product ${ctx.params.id}` }
}
export const shellOutput = t.object({ title: t.string() })
export const shellVariations = { search: { color: ["red", "blue"] } }
export const revalidate = 60
export const revalidateTags = ["catalog"]

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
  cart: {
    // `coupon` is not in the output schema, so no response may carry it.
    load: async (ctx: { readonly request: Request }) => {
      if (new URL(ctx.request.url).searchParams.has("hold")) await holdHole()
      return { count: 2, coupon: "staff-only-coupon" }
    },
    output: t.object({ count: t.number() }),
  },
  slow: {
    load: (ctx: { readonly request: Request; readonly signal: AbortSignal }) => {
      probe.slowStarted++
      const search = new URL(ctx.request.url).searchParams
      if (search.has("fail")) throw new Error("the slow service is down")
      const ms = Number(search.get("slow") ?? "50")
      return abortable(ctx.signal, ms)
    },
    output: t.object({ at: t.number() }),
  },
}
