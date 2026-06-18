/** Realistic-shape nifra server: security headers + CORS + request-id + bearer auth, cookie read,
 * validated query/body, ~3KB list responses — the same work elysia-rw.ts does, idiomatically. */
import { server } from "@nifrajs/core"
import { cors, securityHeaders } from "@nifrajs/middleware"
import { t } from "@nifrajs/schema"

const ORDERS = Array.from({ length: 25 }, (_, i) => ({
  id: `ord_${1000 + i}`,
  sku: `SKU-${i % 7}`,
  qty: (i % 5) + 1,
  pricePaise: 49900 + i * 1375,
  status: i % 3 === 0 ? "shipped" : "pending",
  placedAt: "2026-06-01T10:00:00.000Z",
}))

const app = server()
  .use(securityHeaders())
  .use(cors({ origin: ["https://app.example.com"], credentials: true }))
  .use({
    name: "request-id",
    beforeHandle: (c) => {
      c.set.headers["x-request-id"] = c.req.headers.get("x-request-id") ?? crypto.randomUUID()
    },
  })
  .derive((c) => {
    const auth = c.req.headers.get("authorization")
    if (auth === null || !auth.startsWith("Bearer ") || auth.length < 24) {
      throw new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    }
    return { userId: auth.slice(7, 19), theme: c.cookies.theme ?? "light" }
  })
  .get("/api/orders", { query: t.object({ limit: t.string() }) }, (c) => ({
    user: c.userId,
    theme: c.theme,
    orders: ORDERS.slice(0, Number(c.query.limit) || 10),
    total: ORDERS.length,
  }))
  .post(
    "/api/orders",
    { body: t.object({ sku: t.string(), qty: t.number(), note: t.string() }) },
    (c) => ({ ok: true, id: "ord_new", sku: c.body.sku, qty: c.body.qty, by: c.userId }),
  )

app.listen(Number(Bun.env.PORT ?? 4501))
console.log("nifra-rw ready")
