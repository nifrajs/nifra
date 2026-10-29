/**
 * The one app the runtime differential serves on every runtime. Every answer is a pure function of
 * the request: no clock, no randomness, no per-process state, so any difference between two runtimes
 * is the runtime or its adapter, never the app.
 *
 * It imports nothing runtime-specific. A runtime entry passes in the static-file handler, because the
 * edge build has no filesystem to serve from.
 */
import { isSameOriginPath, server, silentLogger, status } from "@nifrajs/core"
import { method } from "@nifrajs/core/methods"
import { responseContract } from "@nifrajs/core/response-contract"
import { responseObserver } from "@nifrajs/core/response-observer"
import { websocket } from "@nifrajs/core/ws"
import { t } from "@nifrajs/schema/form"
import { createDifferentialPages } from "./pages.ts"

/** Planted in every server-side failure. A body or header that carries it leaked an internal message. */
export const INTERNAL_SENTINEL = "nifra-differential-internal-7f3a"

export type StaticHandler = (request: Request) => Promise<Response | undefined> | undefined

/** The one mount every lane passes its runtime's `serveStatic`: the whole directory, misses to the app. */
export function staticMount(dir: string) {
  return { dir, prefix: "/", fallthrough: true } as const
}

export interface DifferentialAppOptions {
  readonly staticFiles?: StaticHandler
  readonly validateHost?: boolean
}

/** The route cap: small, so a generated length crosses it without sending a megabyte. */
export const MAX_BODY_BYTES = 4096

class ConflictError extends Error {
  readonly item: string
  constructor(item: string) {
    super(`conflict on ${item} (${INTERNAL_SENTINEL})`)
    this.item = item
  }
}

const Item = t.object({
  name: t.string({ minLength: 1, maxLength: 40 }),
  qty: t.integer({ minimum: 0, maximum: 1000 }),
  tags: t.optional(t.array(t.string({ maxLength: 20 }), { maxItems: 4 })),
})

const StoredItem = t.object({
  id: t.string(),
  name: t.string(),
  qty: t.integer(),
  tags: t.array(t.string()),
})

const PublicUser = t.object({ id: t.string(), name: t.string() })
// A constraint only the runtime check sees, so the handler compiles and still breaks its contract.
const Badge = t.object({ code: t.string({ minLength: 4 }) })
const BytesFile = t.object({ name: t.string(), data: t.bytes() })

/** A stand-in for a database row: the response contract must strip the columns it does not declare. */
function userRow(id: string) {
  return { id, name: `user-${id}`, email: `${id}@example.invalid`, passwordHash: INTERNAL_SENTINEL }
}

function encodePath(path: string): string | undefined {
  try {
    return path.split("/").map(encodeURIComponent).join("/")
  } catch {
    return undefined // a lone surrogate has no UTF-8 encoding
  }
}

export function createDifferentialApp(options: DifferentialAppOptions = {}) {
  const staticFiles = options.staticFiles
  const app = server({
    logger: silentLogger,
    maxBodyBytes: MAX_BODY_BYTES,
    validateHost: options.validateHost,
  })
    .use(websocket())
    .use(responseContract("enforce", { extra: "strip" }))
    .use(responseObserver())
    .onResponseHeaders((headers) => {
      headers.set("x-differential", "1")
    })
    .onError((error) => {
      if (error instanceof ConflictError)
        return status(409, { error: "conflict", item: error.item })
      return undefined
    })
    .derive((c) => ({ caller: c.req.headers.get("x-caller") ?? "anonymous" }))
    .beforeHandle((c) => {
      if (c.req.headers.get("x-block") === "1") return status(403, { error: "blocked" })
      return undefined
    })

    .get("/", () => ({ ok: true }))
    .get("/users/:id", { response: PublicUser }, (c) => userRow(c.params.id))
    .get("/users/:id/posts/:post", (c) => ({ user: c.params.id, post: c.params.post }))
    .get("/files/*rest", (c) => ({ rest: c.params.rest }))
    .get("/whoami", (c) => ({ caller: c.caller }))
    // JSON has no bigint or bytes: a bigint is its decimal string, a `t.bytes()` field base64.
    .get("/ids", () => ({ id: 9007199254740993n, ids: [1n, -2n] }))
    .get("/bytes", { response: BytesFile }, () => ({
      name: "a.bin",
      data: new Uint8Array([0, 1, 2, 250, 255]),
    }))
    .get(
      "/headers",
      { headers: t.headers({ "x-count": t.integer({ minimum: 0, maximum: 9 }) }) },
      (c) => ({ count: c.headers["x-count"] }),
    )

    .get(
      "/search",
      {
        query: t.query({
          q: t.string({ minLength: 1, maxLength: 64 }),
          page: t.optional(t.integer({ minimum: 1, maximum: 100 })),
          sort: t.optional(t.union([t.literal("asc"), t.literal("desc")])),
        }),
      },
      (c) => ({ q: c.query.q, page: c.query.page ?? 1, sort: c.query.sort ?? "asc" }),
    )
    .get(
      "/session",
      {
        cookies: t.cookies({
          session: t.string({ minLength: 1 }),
          visits: t.optional(t.integer()),
        }),
      },
      (c) => ({ session: c.cookies.session, visits: c.cookies.visits ?? 0 }),
    )

    .post("/items", { body: Item, response: StoredItem }, (c) => ({
      id: `item-${c.body.name}`,
      name: c.body.name,
      qty: c.body.qty,
      tags: c.body.tags ?? [],
      internal: INTERNAL_SENTINEL,
    }))
    .put("/items/:id", { body: Item }, (c) => {
      if (c.body.name === "taken") throw new ConflictError(c.params.id)
      return { id: c.params.id, name: c.body.name, qty: c.body.qty }
    })
    .patch("/items/:id", { body: t.object({ qty: t.integer({ minimum: 0 }) }) }, (c) => ({
      id: c.params.id,
      qty: c.body.qty,
    }))
    .delete("/items/:id", (c) =>
      status(204, undefined, { headers: { "x-deleted": encodePath(c.params.id) ?? "-" } }),
    )
    .post(
      "/upload",
      {
        body: t.form(
          { title: t.string({ maxLength: 40 }), file: t.file({ maxBytes: 512 }) },
          { maxFiles: 2, maxFields: 4 },
        ),
      },
      (c) => ({ title: c.body.title, size: c.body.file.size }),
    )
    // No schema: the handler reads the body itself, as most hand-written routes do.
    .post("/raw/text", async (c) => ({ length: (await c.req.text()).length }))
    .post("/raw/json", async (c) => ({ type: typeof (await c.req.json()) }))
    .use(method("QUERY", "/query", { body: t.object({ q: t.string() }) }, (c) => ({ q: c.body.q })))
    .use(method("PROPFIND", "/dav/*path", (c) => ({ path: c.params.path })))

    .get("/old/*rest", (c) => {
      // A decoded param can hold any character; a header value holds bytes, so encode it back.
      const location = encodePath(`/new/${c.params.rest}`)
      return location === undefined
        ? status(400, { error: "bad_path" })
        : status(308, undefined, { headers: { location } })
    })
    .get("/go", { query: t.query({ to: t.string() }) }, (c) =>
      isSameOriginPath(c.query.to)
        ? status(302, undefined, { headers: { location: c.query.to } })
        : status(400, { error: "off_origin" }),
    )

    .get("/error/status/:code", (c) => {
      const code = Number(c.params.code)
      return Number.isInteger(code) && code >= 400 && code <= 499
        ? status(code, { error: "chosen" })
        : status(404, { error: "no_status" })
    })
    .get("/error/conflict", () => {
      throw new ConflictError("fixed")
    })
    .get("/error/throw", () => {
      throw new Error(`database password rejected at /srv/app/db.ts:12 (${INTERNAL_SENTINEL})`)
    })
    .get("/error/reject", async () => {
      await Promise.resolve()
      throw new TypeError(`cannot read properties of undefined (${INTERNAL_SENTINEL})`)
    })
    .get("/error/contract", { response: Badge }, () => ({ code: "x", leak: INTERNAL_SENTINEL }))

    .group("/private", (group) =>
      group
        .beforeHandle((c) =>
          c.req.headers.get("authorization") === "Bearer differential"
            ? undefined
            : status(401, { error: "unauthorized" }, { headers: { "www-authenticate": "Bearer" } }),
        )
        .get("/me", (c) => ({ caller: c.caller, scope: "private" })),
    )
    .mount({ path: "/pages", app: createDifferentialPages(INTERNAL_SENTINEL) })

  // A text frame `close:<code>:<reason>` asks the server to close - an empty code or reason is left
  // out - and a close the protocol refuses comes back as `refused:range`; anything else comes back
  // as sent.
  // The close each socket reports is published to `/ws/watch` sockets, the one place a client can
  // see what the server's `close` callback was given.
  app.ws("/ws/echo", {
    message: (ws, data) => {
      if (typeof data === "string" && data.startsWith("close:")) {
        const [, code = "", reason = ""] = data.split(":")
        try {
          ws.close(code === "" ? undefined : Number(code), reason === "" ? undefined : reason)
        } catch (error) {
          ws.send(`refused:${error instanceof RangeError ? "range" : "other"}`)
        }
        return
      }
      ws.send(data)
    },
    close: (_ws, code, reason) => app.publish("watch", `closed:${code}:${reason}`),
  })
  app.ws("/ws/watch", {
    open: (ws) => {
      ws.subscribe("watch")
      ws.send("joined")
    },
  })
  app.ws<{ room: string }>("/ws/room/:room", {
    upgrade: (c) => ({ room: c.params.room ?? "" }),
    open: (ws) => {
      ws.subscribe(`room:${ws.data.room}`)
      ws.send(`joined:${ws.data.room}`)
    },
    message: (ws, data) => app.publish(`room:${ws.data.room}`, data),
  })
  app.ws<{ caller: string }>("/ws/guarded", {
    upgrade: (c) => {
      const token = c.req.headers.get("x-ws-token")
      if (token === "throw") throw new Error(INTERNAL_SENTINEL)
      // Both ways a guard refuses a handshake: a Response, and the status() a handler returns.
      if (token === null) return new Response("unauthorized", { status: 401 })
      if (token !== "ok") return status(403, { error: "bad_token" })
      return { caller: c.caller }
    },
    open: (ws) => ws.send(`hello:${ws.data.caller}`),
  })

  if (staticFiles !== undefined) {
    app.get(
      "/static/*file",
      async (c) => (await staticFiles(c.req)) ?? status(404, { error: "no_file" }),
    )
  }
  return app
}

/** Routes that answer 5xx by design: invariant 1 does not apply to them. */
export const SERVER_ERROR_ROUTES: readonly string[] = [
  "/error/throw",
  "/error/reject",
  "/error/contract",
]
