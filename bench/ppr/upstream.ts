/**
 * A stand-in backend in its own process. `/product/:id` is the catalog: 20 ms per read, a ~20 KB JSON
 * body; the shell loader reads it, so a shell miss costs real network I/O and real JSON parsing.
 * `/part/:ms` is a per-visitor read that takes `ms`, for loaders that read the backend instead of
 * waiting on a timer.
 *
 * `UPSTREAM_SLOTS` caps the reads in progress, like a database's connection pool: a read past the cap
 * waits for one to finish, first come first served, so its latency grows with the load. `/__stats`
 * reports the reads and their waits since the last `/__stats?reset`; `/__count` the catalog reads.
 */
const DELAY_MS = Number(process.env.UPSTREAM_DELAY_MS ?? "20")
const SLOTS = Number(process.env.UPSTREAM_SLOTS ?? "0")
let served = 0
let parts = 0
let busy = 0
const queue: Array<() => void> = []
let waits: number[] = []

const body = (id: string): string =>
  JSON.stringify({
    name: `Product ${id}`,
    price: "$42.00",
    description: "A sturdy cast-iron teapot with an enamel interior. ".repeat(40),
    specs: Array.from({ length: 60 }, (_, i) => ({
      k: `spec-${i}`,
      v: `value ${i} for product ${id}`,
    })),
    related: Array.from({ length: 24 }, (_, i) => ({
      id: `r${i}`,
      name: `Related item ${i}`,
      price: `$${10 + i}.00`,
    })),
  })

/** Run `ms` of work in a slot. A finishing read hands its slot to the oldest waiter. */
async function inSlot(ms: number): Promise<void> {
  const queued = performance.now()
  if (SLOTS > 0 && busy >= SLOTS) await new Promise<void>((resolve) => queue.push(resolve))
  else busy++
  waits.push(performance.now() - queued)
  try {
    await Bun.sleep(ms)
  } finally {
    const next = queue.shift()
    if (next === undefined) busy--
    else next()
  }
}

const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/__count") return Response.json({ served })
    if (url.pathname === "/__stats") {
      const sorted = [...waits].sort((a, b) => a - b)
      const stats = {
        served,
        parts,
        inFlight: busy + queue.length,
        waitP50: percentile(sorted, 0.5),
        waitP99: percentile(sorted, 0.99),
      }
      if (url.searchParams.has("reset")) waits = []
      return Response.json(stats)
    }
    const ms = /^\/part\/(\d{1,5})$/.exec(url.pathname)?.[1]
    if (ms !== undefined) {
      parts++
      await inSlot(Number(ms))
      return Response.json({ ok: true })
    }
    const id = /^\/product\/([A-Za-z0-9-]{1,32})$/.exec(url.pathname)?.[1]
    if (id === undefined) return new Response("not found", { status: 404 })
    served++
    await inSlot(DELAY_MS)
    return new Response(body(id), { headers: { "content-type": "application/json" } })
  },
})
console.log(`upstream on ${server.url}`)
