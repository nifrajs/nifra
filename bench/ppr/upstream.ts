/**
 * A stand-in catalog service in its own process: 20 ms per product read, a ~20 KB JSON body. The shell
 * loader reads it, so a shell miss costs real network I/O and real JSON parsing.
 */
const DELAY_MS = Number(process.env.UPSTREAM_DELAY_MS ?? "20")
let served = 0
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

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/__count") return Response.json({ served })
    const id = /^\/product\/([A-Za-z0-9-]{1,32})$/.exec(url.pathname)?.[1]
    if (id === undefined) return new Response("not found", { status: 404 })
    served++
    await Bun.sleep(DELAY_MS)
    return new Response(body(id), { headers: { "content-type": "application/json" } })
  },
})
console.log(`upstream on ${server.url}`)
