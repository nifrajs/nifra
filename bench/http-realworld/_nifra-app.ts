/**
 * The nifra app under benchmark - shared verbatim by the Bun server (serve.ts), the Node server
 * (serve-node-nifra.ts, via `@nifrajs/node`), and the Deno server (serve-deno.ts), so every runtime
 * section measures the identical app.
 *
 * Deliberately realistic, not bare: security headers, CORS, a request-id hook, bearer-token auth via
 * `.derive()`, a cookie read, validated query + body. This is the SAME shape as bench/realworld/'s
 * preview suite (verified fair against Elysia there) - this directory turns it into the full
 * oha-driven, every-runtime, every-framework matrix bench/http/ already runs for the bare shape.
 *
 * The VALUE imports below deliberately point at the built `dist/` output, not the `@nifrajs/*`
 * package specifiers. `@nifrajs/core`'s package.json resolves a "bun" export condition straight to
 * `src/*.ts` - correct for local app development, but it means a naive `bun run serve.ts` would
 * benchmark live TypeScript source, not what `bun add @nifrajs/core` actually installs and runs.
 * Measured: source ran ~2-4% faster than dist across three A/B rounds on a bare GET (noise-level per
 * round, but consistent direction) - small, but this suite exists specifically to defend nifra's
 * numbers against a "you're gaming your own benchmark" critique, so it has to measure the same
 * artifact a real `bun add @nifrajs/core` user gets. Type-only imports are unaffected (the "types"
 * condition already always points at `dist/*.d.ts`), so only the value import changes.
 *
 * `.derive()` + `.use(beforeHandle)` here mean this route can NEVER take nifra's fused Web lane (bare/
 * query/body-only) - it always runs the general lifecycle path. That's the point: this suite measures
 * what a route with auth and middleware actually gets, not the narrow fast-path shape.
 */
import type { StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core/server"
import { server, status } from "../../packages/core/dist/server.js"
import { cors, securityHeaders } from "../../packages/middleware/dist/index.js"

export const ORDERS = Array.from({ length: 25 }, (_, i) => ({
  id: `ord_${1000 + i}`,
  sku: `SKU-${i % 7}`,
  qty: (i % 5) + 1,
  pricePaise: 49900 + i * 1375,
  status: i % 3 === 0 ? "shipped" : "pending",
  placedAt: "2026-06-01T10:00:00.000Z",
}))

function isOrderBody(v: unknown): v is { sku: string; qty: number; note: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "sku" in v &&
    typeof v.sku === "string" &&
    "qty" in v &&
    typeof v.qty === "number" &&
    "note" in v &&
    typeof v.note === "string"
  )
}

function isLimitQuery(v: unknown): v is { limit: string } {
  return typeof v === "object" && v !== null && "limit" in v && typeof v.limit === "string"
}

const orderBody: StandardSchemaV1<unknown, { sku: string; qty: number; note: string }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-bench",
    validate(value): StandardResult<{ sku: string; qty: number; note: string }> {
      return isOrderBody(value)
        ? { value }
        : { issues: [{ message: "expected { sku: string; qty: number; note: string }" }] }
    },
    types: undefined as unknown as StandardTypes<
      unknown,
      { sku: string; qty: number; note: string }
    >,
  },
}

const limitQuery: StandardSchemaV1<unknown, { limit: string }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-bench",
    validate(value): StandardResult<{ limit: string }> {
      return isLimitQuery(value) ? { value } : { issues: [{ message: "expected ?limit=string" }] }
    },
    types: undefined as unknown as StandardTypes<unknown, { limit: string }>,
  },
}

export function makeNifraApp() {
  return server()
    .use(securityHeaders())
    .use(cors({ origin: ["https://app.example.com"], credentials: true }))
    .use({
      name: "request-id",
      beforeHandle: (c) => {
        c.set.headers["x-request-id"] = c.header("x-request-id") ?? crypto.randomUUID()
      },
    })
    .derive((c) => {
      const auth = c.header("authorization")
      // The guard shape nifra documents: a plain render returned from the derive, not a `Response`
      // built and thrown. Same 401 on the wire; it skips the object and the rejection lane.
      if (auth === null || !auth.startsWith("Bearer ") || auth.length < 24) {
        return status(401, { ok: false, error: "unauthorized" })
      }
      return { userId: auth.slice(7, 19), theme: c.cookies.theme ?? "light" }
    })
    .get("/api/orders", { query: limitQuery }, (c) => ({
      user: c.userId,
      theme: c.theme,
      orders: ORDERS.slice(0, Number(c.query.limit) || 10),
      total: ORDERS.length,
    }))
    .post("/api/orders", { body: orderBody }, (c) => ({
      ok: true,
      id: "ord_new",
      sku: c.body.sku,
      qty: c.body.qty,
      by: c.userId,
    }))
}
