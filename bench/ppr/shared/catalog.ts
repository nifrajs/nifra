import { t } from "@nifrajs/schema"

/**
 * The bench page's data. The product comes from the catalog process when `PPR_UPSTREAM` is set (S1: 20
 * ms and ~20 KB per read) and inline otherwise (S0). The three per-visitor parts settle at 40, 150 and
 * 400 ms times the request's `scale`, so `scale=0` measures render work alone.
 */
export interface Product {
  readonly id: string
  readonly name: string
  readonly price: string
  readonly description: string
  readonly specs: readonly { readonly k: string; readonly v: string }[]
  readonly related: readonly {
    readonly id: string
    readonly name: string
    readonly price: string
  }[]
}

export const productSchema = t.object({
  id: t.string(),
  name: t.string(),
  price: t.string(),
  description: t.string(),
  specs: t.array(t.object({ k: t.string(), v: t.string() })),
  related: t.array(t.object({ id: t.string(), name: t.string(), price: t.string() })),
})

export async function readProduct(id: string): Promise<Product> {
  const upstream = process.env.PPR_UPSTREAM
  if (upstream === undefined || upstream === "") {
    return { id, name: `Product ${id}`, price: "$42.00", description: "", specs: [], related: [] }
  }
  const response = await fetch(`${upstream}/product/${encodeURIComponent(id)}`)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the bench's own catalog process writes this shape (bench/ppr/upstream.ts).
  const body = (await response.json()) as Omit<Product, "id">
  return { id, ...body }
}

export const greetingSchema = t.object({ name: t.string() })
export const cartSchema = t.object({ count: t.number() })
export const recsSchema = t.object({ items: t.array(t.string()) })

const scaleOf = (request: Request): number =>
  Number(new URL(request.url).searchParams.get("scale") ?? "1")

const after = <T>(ms: number, value: T): Promise<T> =>
  ms <= 0 ? Promise.resolve(value) : new Promise((resolve) => setTimeout(() => resolve(value), ms))

const RECS = Array.from({ length: 8 }, (_, i) => `Recommended tea ${i}`)

export const loadGreeting = (request: Request) =>
  after(40 * scaleOf(request), {
    name: /(?:^|;\s*)user=([^;]*)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? "guest",
  })
export const loadCart = (request: Request) => after(150 * scaleOf(request), { count: 2 })
export const loadRecs = (request: Request) => after(400 * scaleOf(request), { items: RECS })
