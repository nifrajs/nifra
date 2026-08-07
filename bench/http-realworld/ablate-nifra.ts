/**
 * Ablation ladder for the realistic nifra GET - the same route with one stage removed per rung.
 *
 * The kernel rig established that nifra's realistic-GET deficit against Fastify is ~0.8 us of
 * fixed, payload-independent, main-thread user CPU, spread across stages rather than sitting in
 * one. This server prices each stage: run consecutive rungs and the difference between them IS
 * that stage's per-request cost. `ablate-fastify.ts` is the matching ladder, so each stage can be
 * priced against the peer's implementation of the same idea rather than against zero.
 *
 * Rungs are CUMULATIVE - each removes one more stage than the one before:
 *
 *   full      securityHeaders + cors + request-id hook + auth derive + cookie + query schema
 *   nocors    - cors
 *   nosec     - securityHeaders            (declared, not hooked - the static tier)
 *   noreqid   - request-id beforeHandle
 *   noderive  - auth derive + cookie read  (folded into the handler)
 *   bare      - query schema               (limit fixed; nothing but router -> handler)
 *
 * The `full` rung is deliberately byte-identical in behavior to `_nifra-app.ts`, so its number is
 * comparable to every other realistic-shape row this repo publishes.
 *
 *   node bench/http-realworld/dist/ablate-nifra.js <rung> <port>
 *
 * Value imports point at built `dist/`, not the `@nifrajs/*` specifiers, for the same reason
 * `_nifra-app.ts` documents: the "bun" export condition would otherwise benchmark live TS source
 * instead of what `bun add` installs.
 */
import type { StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core/server"
import { serve } from "@nifrajs/node"
import { server } from "../../packages/core/dist/server.js"
import { cors, securityHeaders } from "../../packages/middleware/dist/index.js"

const RUNGS = ["full", "nocors", "nosec", "noreqid", "noderive", "bare"] as const
type Rung = (typeof RUNGS)[number]

const rung = process.argv[2] as Rung
const port = Number(process.argv[3])
if (!RUNGS.includes(rung) || !Number.isInteger(port)) {
  throw new Error(`usage: node ablate-nifra.js <${RUNGS.join("|")}> <port>`)
}

// Rung n keeps every stage strictly above it in the ladder.
const rank = RUNGS.indexOf(rung)
const hasCors = rank < RUNGS.indexOf("nocors")
const hasSec = rank < RUNGS.indexOf("nosec")
const hasReqId = rank < RUNGS.indexOf("noreqid")
const hasDerive = rank < RUNGS.indexOf("noderive")
const hasQuery = rank < RUNGS.indexOf("bare")

const ORDERS = Array.from({ length: 25 }, (_, i) => ({
  id: `ord_${1000 + i}`,
  sku: `SKU-${i % 7}`,
  qty: (i % 5) + 1,
  pricePaise: 49900 + i * 1375,
  status: i % 3 === 0 ? "shipped" : "pending",
  placedAt: "2026-06-01T10:00:00.000Z",
}))

function isLimitQuery(v: unknown): v is { limit: string } {
  return typeof v === "object" && v !== null && "limit" in v && typeof v.limit === "string"
}

const limitQuery: StandardSchemaV1<unknown, { limit: string }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-bench",
    validate: (value): StandardResult<{ limit: string }> =>
      isLimitQuery(value) ? { value } : { issues: [{ message: "expected ?limit=string" }] },
    types: undefined as unknown as StandardTypes<unknown, { limit: string }>,
  },
}

const UNAUTHORIZED = () =>
  new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  })

// Rungs below `noderive` still authenticate - the work moves into the handler rather than
// disappearing, so the rung prices the DERIVE STAGE, not the auth check itself.
function authOf(auth: string | null): string {
  if (auth === null || !auth.startsWith("Bearer ") || auth.length < 24) throw UNAUTHORIZED()
  return auth.slice(7, 19)
}

// The ladder reshapes the app's context type on every rung, so the chain is built through a
// deliberately untyped local. `_nifra-app.ts` keeps the fully-typed chain; this file is a harness.
// biome-ignore lint/suspicious/noExplicitAny: rung-dependent context shape
type AnyApp = any
// biome-ignore lint/suspicious/noExplicitAny: rung-dependent context shape
type AnyCtx = any
let app: AnyApp = server()
if (hasSec) app = app.use(securityHeaders())
if (hasCors) app = app.use(cors({ origin: ["https://app.example.com"], credentials: true }))
if (hasReqId) {
  app = app.use({
    name: "request-id",
    beforeHandle: (c: AnyCtx) => {
      c.set.headers["x-request-id"] = c.header("x-request-id") ?? crypto.randomUUID()
    },
  })
}
if (hasDerive) {
  app = app.derive((c: AnyCtx) => ({
    userId: authOf(c.header("authorization")),
    theme: c.cookies.theme ?? "light",
  }))
}

const body = (userId: string, theme: string, limit: number) => ({
  user: userId,
  theme,
  orders: ORDERS.slice(0, limit),
  total: ORDERS.length,
})

if (hasDerive) {
  app = hasQuery
    ? app.get("/api/orders", { query: limitQuery }, (c: AnyCtx) =>
        body(c.userId, c.theme, Number(c.query.limit) || 10),
      )
    : app.get("/api/orders", (c: AnyCtx) => body(c.userId, c.theme, 10))
} else {
  // No derive: the handler does the identical auth + cookie work inline.
  app = app.get("/api/orders", (c: AnyCtx) => {
    const userId = authOf(c.header("authorization"))
    return body(userId, c.cookies.theme ?? "light", 10)
  })
}

await serve(app, { port })
