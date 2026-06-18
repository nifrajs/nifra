/** Realistic-shape Elysia server — identical work to nifra-rw.ts via Elysia idioms. */
import { Elysia, t as et } from "elysia"

const ORDERS = Array.from({ length: 25 }, (_, i) => ({
  id: `ord_${1000 + i}`,
  sku: `SKU-${i % 7}`,
  qty: (i % 5) + 1,
  pricePaise: 49900 + i * 1375,
  status: i % 3 === 0 ? "shipped" : "pending",
  placedAt: "2026-06-01T10:00:00.000Z",
}))

const SEC = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=15552000; includeSubDomains",
}

new Elysia()
  .onAfterHandle(({ set, request }) => {
    Object.assign(set.headers, SEC)
    set.headers["access-control-allow-origin"] = "https://app.example.com"
    set.headers["access-control-allow-credentials"] = "true"
    set.headers["x-request-id"] = request.headers.get("x-request-id") ?? crypto.randomUUID()
  })
  .derive(({ request, cookie, status }) => {
    const auth = request.headers.get("authorization")
    if (auth === null || !auth.startsWith("Bearer ") || auth.length < 24) {
      return status(401, { ok: false, error: "unauthorized" }) as never
    }
    return { userId: auth.slice(7, 19), theme: cookie.theme?.value ?? "light" }
  })
  .get(
    "/api/orders",
    ({ query, userId, theme }) => ({
      user: userId,
      theme,
      orders: ORDERS.slice(0, Number(query.limit) || 10),
      total: ORDERS.length,
    }),
    { query: et.Object({ limit: et.String() }) },
  )
  .post(
    "/api/orders",
    ({ body, userId }) => ({ ok: true, id: "ord_new", sku: body.sku, qty: body.qty, by: userId }),
    { body: et.Object({ sku: et.String(), qty: et.Number(), note: et.String() }) },
  )
  .listen(Number(Bun.env.PORT ?? 4502))
console.log("elysia-rw ready")
