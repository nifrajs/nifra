/**
 * Ablation ladder for the realistic Fastify GET - the peer half of `ablate-nifra.ts`.
 *
 * Same rungs, same cumulative order, each stage expressed in Fastify's own idiom. Running both
 * ladders turns "nifra is ~0.8 us slower per realistic GET" into a per-stage bill: the difference
 * between two consecutive rungs is what that stage costs in each framework, so a stage nifra
 * charges more for shows up as a bigger step on its ladder rather than as a bigger baseline.
 *
 * FAIRNESS, deliberately: this ladder writes Fastify the FAST way, which the published arm in
 * serve-node.ts does not.
 *
 *   - Hooks are synchronous and call `done`. Fastify's hook runner only pays a promise and a
 *     microtask when a hook RETURNS a thenable (lib/hooks.js: `if (result && typeof result.then
 *     === 'function')`). Declaring a hook `async` therefore costs a fastify app a microtask per
 *     hook per request that a sync one does not - a property of how the hook was written, not of
 *     the framework. serve-node.ts declares both of its hooks `async`; the `full-slow` rung below
 *     reproduces that exactly so the authoring penalty can be priced instead of assumed.
 *   - Header entries are hoisted. `Object.entries(SEC)` inside the hook allocates a fresh pair
 *     array per header per request.
 *   - The header SET matches nifra's byte for byte: nifra's `securityHeaders()` emits no HSTS and
 *     its `cors()` emits `vary: Origin`, so this ladder does the same. The published arm sends HSTS
 *     and no `vary`, making its responses 66 bytes larger - a handicap against Fastify, not for it.
 *     (Fastify still appends `; charset=utf-8` to the content-type; that is its own default and is
 *     left alone.)
 *
 * The one thing NOT equalized is the mechanism itself: nifra's `securityHeaders()` declares static
 * headers into response construction with no hook at all, and Fastify has no equivalent tier - a
 * hook is its recommended way to attach fixed response headers. That difference is a real framework
 * capability gap and the ladder is meant to price it, not hide it.
 *
 *   node bench/http-realworld/ablate-fastify.ts <rung> <port>
 */
const RUNGS = ["full", "nocors", "nosec", "noreqid", "noderive", "bare"] as const
type Rung = (typeof RUNGS)[number]

const arg = process.argv[2]
const port = Number(process.argv[3])
// `full-slow` is `full` written the way the published arm writes it: async hooks + per-request
// Object.entries + HSTS instead of vary. It exists only to price that authoring difference.
const slow = arg === "full-slow"
const rung = (slow ? "full" : arg) as Rung
if (!RUNGS.includes(rung) || !Number.isInteger(port)) {
  throw new Error(`usage: node ablate-fastify.ts <${RUNGS.join("|")}|full-slow> <port>`)
}

const rank = RUNGS.indexOf(rung)
const hasCors = rank < RUNGS.indexOf("nocors")
const hasSec = rank < RUNGS.indexOf("nosec")
const hasReqId = rank < RUNGS.indexOf("noreqid")
const hasDerive = rank < RUNGS.indexOf("noderive")
const hasQuery = rank < RUNGS.indexOf("bare")

// Exactly what nifra's securityHeaders() emits (no HSTS), unless the slow rung is reproducing the
// published arm's set.
const SEC: Record<string, string> = slow
  ? {
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=15552000; includeSubDomains",
    }
  : {
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    }
// Exactly what nifra's cors({ origin, credentials }) emits, including the `vary`.
const CORS: Record<string, string> = slow
  ? {
      "access-control-allow-origin": "https://app.example.com",
      "access-control-allow-credentials": "true",
    }
  : {
      "access-control-allow-origin": "https://app.example.com",
      vary: "Origin",
      "access-control-allow-credentials": "true",
    }
const SEC_ENTRIES = Object.entries(SEC)
const CORS_ENTRIES = Object.entries(CORS)

const ORDERS = Array.from({ length: 25 }, (_, i) => ({
  id: `ord_${1000 + i}`,
  sku: `SKU-${i % 7}`,
  qty: (i % 5) + 1,
  pricePaise: 49900 + i * 1375,
  status: i % 3 === 0 ? "shipped" : "pending",
  placedAt: "2026-06-01T10:00:00.000Z",
}))

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

type Who = { userId: string; theme: string }
function authOf(authHeader: string | undefined, cookieHeader: string | undefined): Who | undefined {
  if (authHeader === undefined || !authHeader.startsWith("Bearer ") || authHeader.length < 24) {
    return undefined
  }
  return { userId: authHeader.slice(7, 19), theme: readCookie(cookieHeader, "theme") ?? "light" }
}

const body = (who: Who, limit: number) => ({
  user: who.userId,
  theme: who.theme,
  orders: ORDERS.slice(0, limit),
  total: ORDERS.length,
})

const { default: Fastify } = await import("fastify")
const app = Fastify()

// One onSend hook carries whichever response-header stages this rung keeps - matching nifra's
// single response walk.
if (hasSec || hasCors || hasReqId) {
  if (slow) {
    app.addHook("onSend", async (req, reply, payload) => {
      if (hasSec) for (const [k, v] of Object.entries(SEC)) reply.header(k, v)
      if (hasCors) for (const [k, v] of Object.entries(CORS)) reply.header(k, v)
      if (hasReqId) reply.header("x-request-id", req.headers["x-request-id"] ?? crypto.randomUUID())
      return payload
    })
  } else {
    app.addHook("onSend", (req, reply, payload, done) => {
      if (hasSec) for (const [k, v] of SEC_ENTRIES) reply.header(k, v)
      if (hasCors) for (const [k, v] of CORS_ENTRIES) reply.header(k, v)
      if (hasReqId) reply.header("x-request-id", req.headers["x-request-id"] ?? crypto.randomUUID())
      done(null, payload)
    })
  }
}

if (hasDerive) {
  if (slow) {
    app.addHook("preHandler", async (req, reply) => {
      const who = authOf(req.headers.authorization, req.headers.cookie)
      if (who === undefined) {
        reply.code(401).send({ ok: false, error: "unauthorized" })
        return
      }
      ;(req as unknown as { who: Who }).who = who
    })
  } else {
    app.addHook("preHandler", (req, reply, done) => {
      const who = authOf(req.headers.authorization, req.headers.cookie)
      if (who === undefined) {
        reply.code(401).send({ ok: false, error: "unauthorized" })
        return
      }
      ;(req as unknown as { who: Who }).who = who
      done()
    })
  }
}

const querySchema = {
  schema: {
    querystring: { type: "object", required: ["limit"], properties: { limit: { type: "string" } } },
  },
}

app.get<{ Querystring: { limit: string } }>(
  "/api/orders",
  hasQuery ? querySchema : {},
  (req, reply) => {
    if (hasDerive) {
      const who = (req as unknown as { who: Who }).who
      return body(who, hasQuery ? Number(req.query.limit) || 10 : 10)
    }
    // No preHandler: the handler does the identical auth + cookie work inline.
    const who = authOf(req.headers.authorization, req.headers.cookie)
    if (who === undefined) return reply.code(401).send({ ok: false, error: "unauthorized" })
    return body(who, 10)
  },
)

// `--cpu-prof` writes its profile on process EXIT; a default SIGINT terminates without one, so the
// profiling rig would get an empty directory. Exit gracefully instead (also makes teardown clean).
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0))

await app.listen({ port })
