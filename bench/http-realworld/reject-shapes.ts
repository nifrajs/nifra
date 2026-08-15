/**
 * The ways to answer early, one per server process, so rejection cost splits into its parts.
 *
 * The realistic app rejects by throwing a `Response` from a derive, and that path measures at ~39k
 * rps against ~62k for the authorized GET it protects - rejecting costs MORE than serving, where
 * fastify's rejection is CHEAPER than its serve. Three things could account for it: constructing a
 * Web `Response` at all, throwing rather than returning it, or throwing from a derive rather than
 * from the handler. One shape each, all answering `GET /x`:
 *
 *   status        set.status + a plain object   - no Response constructed, the ordinary JSON lane
 *   before        beforeHandle returns a value  - the same lane, reached the way a guard should
 *   return        return new Response(...)      - Response constructed, no throw
 *   throw         throw  new Response(...)      - Response constructed, thrown from the handler
 *   derive-throw  throw  new Response(...)      - thrown from a derive, i.e. the real app's shape
 *   helper        derive returns status(...)    - the fix: a derive exits early, as plain data
 *   helper-throw  derive throws  status(...)    - the fix, for a guard helper that ends by throwing
 *
 * Two more shapes ask the same question of the errors the FRAMEWORK renders, which no user code can
 * move onto a faster lane:
 *
 *   not-found     no route at all               - the framework's own 404
 *   invalid       a query schema that rejects   - the framework's own 422
 *
 * `before` is what a guard costs when it never leaves the JSON lane: a non-undefined `beforeHandle`
 * return short-circuits into the same `finalize` a handler return reaches. `status` - `return` is
 * the price of the Response object, `return` - `throw` the price of the throw, `throw` -
 * `derive-throw` the price of unwinding a lifecycle stage rather than a handler.
 *
 * One shape per PROCESS, not one route per shape: a `derive` and a `beforeHandle` both apply to
 * every route registered after them, so shapes on one chain contaminate each other. An earlier
 * version put all five on one server and the `before` route inherited the throwing derive above it -
 * it answered 401 and gated green while measuring the very path it existed to be compared against.
 * Middleware matches _nifra-app.ts so the numbers sit on the ablation ladder's baseline.
 *
 *   node <bundled reject-shapes.js> <status|before|return|throw|derive-throw> <port>
 */
// The built `dist`, not `src` - same rule as serve.ts and _nifra-app.ts: a bench that imports source
// measures an artifact no user runs.
import { server, status as statusResult } from "../../packages/core/dist/index.js"
import { cors } from "../../packages/middleware/dist/index.js"

const SHAPES = [
  "status",
  "before",
  "return",
  "throw",
  "derive-throw",
  "helper",
  "helper-throw",
  "not-found",
  "invalid",
] as const
type Shape = (typeof SHAPES)[number]

/** What each shape must answer. The driver asserts this before timing: oha counts any completed
 * request, so a shape that quietly answered 200 would gate green and read as a fast rejection. */
export const EXPECTED: Readonly<Record<Shape, number>> = {
  status: 401,
  before: 401,
  return: 401,
  throw: 401,
  "derive-throw": 401,
  helper: 401,
  "helper-throw": 401,
  "not-found": 404,
  invalid: 422,
}

declare const Bun: { serve(options: { port: number; fetch: unknown }): unknown } | undefined
declare const Deno: { args: string[]; serve(options: { port: number }, handler: unknown): unknown }

const argv = typeof Deno !== "undefined" ? Deno.args : process.argv.slice(2)
const shape = argv[0] as Shape
const port = Number(argv[1])
if (!SHAPES.includes(shape) || !Number.isInteger(port)) {
  throw new Error(`usage: node <bundled reject-shapes.js> <${SHAPES.join("|")}> <port>`)
}

const BODY = JSON.stringify({ ok: false, error: "unauthorized" })
const PAYLOAD = { ok: false, error: "unauthorized" }
const unauthorized = (): Response =>
  new Response(BODY, { status: 401, headers: { "content-type": "application/json" } })

// biome-ignore lint/suspicious/noExplicitAny: the derive reshapes the context type mid-chain
type AnyApp = any

let app: AnyApp = server()
  .use(cors({ origin: ["https://app.example.com"], credentials: true }))
  .use({
    name: "request-id",
    beforeHandle: (c: AnyApp) => {
      c.set.headers["x-request-id"] = c.header("x-request-id") ?? crypto.randomUUID()
    },
  })

if (shape === "before") {
  app = app.use({
    name: "guard",
    beforeHandle: (c: AnyApp) => {
      c.set.status = 401
      return PAYLOAD
    },
  })
} else if (shape === "derive-throw") {
  app = app.derive(() => {
    throw unauthorized()
  })
} else if (shape === "helper") {
  app = app.derive(() => statusResult(401, PAYLOAD))
} else if (shape === "helper-throw") {
  app = app.derive(() => {
    throw statusResult(401, PAYLOAD)
  })
}

// `not-found` registers the route somewhere else entirely, so `GET /x` misses the router and the
// framework renders the 404 itself - the one rejection an app cannot move onto a faster lane.
const path = shape === "not-found" ? "/elsewhere" : "/x"

// `invalid` fails the framework's own validation: a query schema that rejects everything, so the
// request is answered 422 before any handler, derive, or beforeHandle runs.
const rejectingQuery = {
  "~standard": {
    version: 1,
    vendor: "nifra-bench",
    validate: () => ({ issues: [{ message: "expected a token", path: ["token"] }] }),
    types: undefined,
  },
}

const handler = (c: AnyApp): unknown => {
  if (shape === "status") {
    c.set.status = 401
    return PAYLOAD
  }
  if (shape === "return") return unauthorized()
  if (shape === "throw") throw unauthorized()
  // Every other shape exits before the handler.
  return { ok: true, unreachable: true }
}

app =
  shape === "invalid" ? app.get(path, { query: rejectingQuery }, handler) : app.get(path, handler)

// Runtime-agnostic on purpose: the rejection cost is not the same question on each. Node has to
// build a `Response` and drain it back out, so a plain render skips undici entirely; Bun and Deno
// are Web-native and end up returning one either way, so what a plain render saves there is the
// construction shape, not the object. Same app, same shapes, one file.
//
// Each runtime through the adapter a real app uses - `app.listen` on Bun, `@nifrajs/deno`'s `serve`
// on Deno, `@nifrajs/node`'s on Node - never a bare `Bun.serve({ fetch: app.fetch })`: the adapter
// is part of what is being priced, and an unbound `app.fetch` is not even a working app.
if (typeof Bun !== "undefined") {
  app.listen(port)
} else if (typeof Deno !== "undefined") {
  // The built `dist`, like every other import here - and load-bearing beyond consistency: the root
  // tsconfig excludes `packages/deno` (it needs Deno's lib, which this DOM-free program has not
  // got), but an import of its SOURCE pulls it back into the program through `paths` and fails the
  // typecheck. The emitted `.d.ts` references no `Deno.*` type, so the dist import does not.
  const { serve } = await import("../../packages/deno/dist/index.js")
  serve(app, { port })
} else {
  const { serve } = await import("@nifrajs/node")
  // `--cpu-prof` writes its profile on process EXIT; a default SIGINT terminates without one. Set
  // before `serve`, which never returns.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0))
  await serve(app, { port })
}
