import type { Product } from "../shared/catalog.ts"

/**
 * The bench page's server data. The product comes from the catalog process when `PPR_UPSTREAM` is set
 * (S1: 20 ms and ~20 KB per read) and inline otherwise (S0). The three per-visitor parts settle at 40,
 * 150 and 400 ms times the request's `scale`, so `scale=0` measures render work alone: on a timer, or
 * with `PPR_PARTS_UPSTREAM=1` by reading the catalog process for that long, where a capped pool of
 * reads makes them wait under load.
 */
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

const scaleOf = (request: Request): number =>
  Number(new URL(request.url).searchParams.get("scale") ?? "1")

function after<T>(ms: number, value: T): Promise<T> {
  if (process.env.PPR_PARTS_UPSTREAM === "1") {
    return fetch(`${process.env.PPR_UPSTREAM}/part/${ms}`)
      .then((response) => response.json())
      .then(() => value)
  }
  return ms <= 0
    ? Promise.resolve(value)
    : new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

const RECS = Array.from({ length: 8 }, (_, i) => `Recommended tea ${i}`)

export const loadGreeting = (request: Request) =>
  after(40 * scaleOf(request), {
    name: /(?:^|;\s*)user=([^;]*)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? "guest",
  })
export const loadCart = (request: Request) => after(150 * scaleOf(request), { count: 2 })
export const loadRecs = (request: Request) => after(400 * scaleOf(request), { items: RECS })
