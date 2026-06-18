/** Realistic-shape Hono server — identical work to nifra-rw.ts via Hono idioms (secure headers + CORS
 * + request-id + bearer auth + cookie read + validated query + a ~3KB list response). */
import { Hono } from "hono"
import { getCookie } from "hono/cookie"
import { cors } from "hono/cors"
import { secureHeaders } from "hono/secure-headers"
import { validator } from "hono/validator"

const ORDERS = Array.from({ length: 25 }, (_, i) => ({
  id: `ord_${1000 + i}`,
  sku: `SKU-${i % 7}`,
  qty: (i % 5) + 1,
  pricePaise: 49900 + i * 1375,
  status: i % 3 === 0 ? "shipped" : "pending",
  placedAt: "2026-06-01T10:00:00.000Z",
}))

const app = new Hono<{ Variables: { userId: string; theme: string } }>()

app.use("*", secureHeaders())
app.use("*", cors({ origin: "https://app.example.com", credentials: true }))
app.use("*", async (c, next) => {
  c.header("x-request-id", c.req.header("x-request-id") ?? crypto.randomUUID())
  const auth = c.req.header("authorization")
  if (auth === undefined || !auth.startsWith("Bearer ") || auth.length < 24) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  c.set("userId", auth.slice(7, 19))
  c.set("theme", getCookie(c, "theme") ?? "light")
  await next()
  return undefined
})

app.get(
  "/api/orders",
  validator("query", (value, c) => {
    const limit = value.limit
    if (typeof limit !== "string") return c.json({ ok: false, error: "bad_query" }, 400)
    return { limit }
  }),
  (c) => {
    const { limit } = c.req.valid("query")
    return c.json({
      user: c.get("userId"),
      theme: c.get("theme"),
      orders: ORDERS.slice(0, Number(limit) || 10),
      total: ORDERS.length,
    })
  },
)

app.post(
  "/api/orders",
  validator("json", (value, c) => {
    const { sku, qty, note } = value as { sku?: unknown; qty?: unknown; note?: unknown }
    if (typeof sku !== "string" || typeof qty !== "number" || typeof note !== "string") {
      return c.json({ ok: false, error: "bad_body" }, 400)
    }
    return { sku, qty, note }
  }),
  (c) => {
    const { sku, qty } = c.req.valid("json")
    return c.json({ ok: true, id: "ord_new", sku, qty, by: c.get("userId") })
  },
)

if (import.meta.main) {
  Bun.serve({ port: Number(Bun.env.PORT ?? 4503), fetch: app.fetch })
  console.log("hono-rw ready")
}
