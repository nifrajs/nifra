import { afterEach, describe, expect, test } from "bun:test"
import { type AnyServer, type RunningServer, server } from "@nifrajs/core"
import { defineContract, implement } from "@nifrajs/core/contract"
import { all, method } from "@nifrajs/core/methods"
import { nodeDirect } from "@nifrajs/core/node-direct"
import { reflectRoutes } from "@nifrajs/core/reflection"
import { streaming } from "@nifrajs/core/sse"
import { websocket } from "@nifrajs/core/ws"
import { t } from "@nifrajs/schema"
import { apiKey, basicAuth, bearer, jwt, requestId } from "../src/index.ts"

/**
 * First-party auth refuses a request before anything reads it: no body read, no validation, no
 * `derive` or `beforeHandle`. Optional auth never refuses, so validation still answers there.
 */

const SECRET = "0123456789abcdef0123456789abcdef"
const ENC = new TextEncoder()

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ""
  for (const b of view) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function hmacToken(claims: Record<string, unknown>): Promise<string> {
  const head = b64url(ENC.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))
  const body = b64url(ENC.encode(JSON.stringify(claims)))
  const key = await crypto.subtle.importKey(
    "raw",
    ENC.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, ENC.encode(`${head}.${body}`))
  return `${head}.${body}.${b64url(sig)}`
}

const TOKEN = await hmacToken({ sub: "u1", exp: Math.floor(Date.now() / 1000) + 3_600 })

interface Guard {
  readonly name: string
  /** A fresh guard, and how to read the principal it verified. */
  readonly make: (optional: boolean) => {
    readonly install: (app: AnyServer) => AnyServer
    readonly principal: (request: Request) => unknown
  }
  readonly good: Record<string, string>
  readonly challenge: string | null
}

const GUARDS: readonly Guard[] = [
  {
    name: "basicAuth",
    make: (optional) => {
      const guard = basicAuth({ username: "u", password: "p", optional })
      return { install: (app) => app.use(guard), principal: (request) => guard.principal(request) }
    },
    good: { authorization: `Basic ${btoa("u:p")}` },
    challenge: "Basic",
  },
  {
    name: "bearer",
    make: (optional) => {
      const guard = bearer({ verify: (t) => (t === "good" ? { id: "u1" } : null), optional })
      return { install: (app) => app.use(guard), principal: (request) => guard.principal(request) }
    },
    good: { authorization: "Bearer good" },
    challenge: "Bearer",
  },
  {
    name: "apiKey",
    make: (optional) => {
      const guard = apiKey({ keys: ["k1"], optional })
      return { install: (app) => app.use(guard), principal: (request) => guard.principal(request) }
    },
    good: { "x-api-key": "k1" },
    challenge: null,
  },
  {
    name: "jwt (header)",
    make: (optional) => {
      const guard = jwt({ key: SECRET, algorithms: ["HS256"], optional })
      return {
        install: (app) => app.use(guard),
        principal: (request) => guard.claims(request)?.sub ?? null,
      }
    },
    good: { authorization: `Bearer ${TOKEN}` },
    challenge: "Bearer",
  },
  {
    name: "jwt (cookie)",
    make: (optional) => {
      const guard = jwt({ key: SECRET, algorithms: ["HS256"], cookie: "session", optional })
      return {
        install: (app) => app.use(guard),
        principal: (request) => guard.claims(request)?.sub ?? null,
      }
    },
    good: { cookie: `session=${TOKEN}` },
    challenge: "Bearer",
  },
]

/** A body schema that counts how often it runs; `{ name: string }` passes. */
function countingBody() {
  const counter = { runs: 0 }
  const schema = {
    "~standard": {
      version: 1 as const,
      vendor: "auth-first-test",
      validate: (value: unknown) => {
        counter.runs += 1
        return typeof value === "object" &&
          value !== null &&
          typeof Reflect.get(value, "name") === "string"
          ? { value }
          : { issues: [{ message: "name is required", path: ["name"] }] }
      },
    },
  }
  return { counter, schema }
}

/** Bun and undici require `duplex` for a streaming request body; the DOM lib does not declare it. */
type StreamingInit = RequestInit & { readonly duplex: "half" }

const post = (headers: Record<string, string>, body: BodyInit, path = "/items"): Request => {
  const init: StreamingInit = {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    duplex: "half",
  }
  return new Request(`http://x${path}`, init)
}

type Lane = (app: AnyServer, request: Request) => Promise<{ status: number; headers: Headers }>

let running: RunningServer | undefined
afterEach(() => {
  running?.stop(true)
  running = undefined
})

const LANES: ReadonlyArray<readonly [string, Lane]> = [
  [
    "app.fetch",
    async (app, request) => {
      const response = await app.fetch(request)
      return { status: response.status, headers: response.headers }
    },
  ],
  [
    "node",
    async (app, request) => {
      const outcome = await app.resolveNode(request)
      if (outcome.kind === "response") {
        return { status: outcome.response.status, headers: outcome.response.headers }
      }
      const headers = new Headers()
      for (const [name, value] of Object.entries(outcome.headers ?? {})) {
        headers.set(name, Array.isArray(value) ? value.join(", ") : String(value))
      }
      return { status: outcome.status, headers }
    },
  ],
  [
    "bun listen",
    async (app, request) => {
      running = app.listen(0, { hostname: "127.0.0.1" })
      const url = new URL(request.url)
      const init: StreamingInit = {
        method: request.method,
        headers: request.headers,
        body: request.body,
        duplex: "half",
      }
      const response = await fetch(
        `http://127.0.0.1:${running.port}${url.pathname}${url.search}`,
        init,
      )
      await response.arrayBuffer()
      return { status: response.status, headers: response.headers }
    },
  ],
]

describe("required first-party auth refuses before reading the request", () => {
  for (const guard of GUARDS) {
    for (const [lane, send] of LANES) {
      test(`${guard.name} on ${lane}: no credentials is 401 with the challenge; nothing ran`, async () => {
        const { install } = guard.make(false)
        const { counter, schema } = countingBody()
        const hooks = { derive: 0, before: 0, handler: 0 }
        const app = install(server().use(nodeDirect()))
          .derive(() => {
            hooks.derive += 1
            return {}
          })
          .beforeHandle(() => {
            hooks.before += 1
          })
          .post("/items", { body: schema }, () => {
            hooks.handler += 1
            return { ok: true }
          })
        const request = post({}, '{"wrong":1}')
        const response = await send(app, request)
        expect(response.status).toBe(401)
        const challenge = response.headers.get("www-authenticate")
        if (guard.challenge === null) expect(challenge).toBeNull()
        else expect(challenge).toStartWith(guard.challenge)
        expect(counter.runs).toBe(0)
        // The listen lane forwards the body itself, so only the in-process lanes can see it untouched.
        if (lane !== "bun listen") expect(request.bodyUsed).toBe(false)
        expect(hooks).toEqual({ derive: 0, before: 0, handler: 0 })
      })
    }

    test(`${guard.name}: an oversized body is 401, never 413`, async () => {
      const { install } = guard.make(false)
      const { schema } = countingBody()
      const app = install(server()).post("/items", { body: schema, bodyLimit: 16 }, () => ({
        ok: true,
      }))
      const response = await app.fetch(post({}, JSON.stringify({ name: "x".repeat(4_096) })))
      expect(response.status).toBe(401)
    })

    test(`${guard.name}: valid credentials and a bad body is 422; a good one reaches the handler with its principal`, async () => {
      const { install, principal } = guard.make(false)
      const { schema } = countingBody()
      const app = install(server()).post("/items", { body: schema }, (c) => ({
        principal: principal(c.req),
      }))
      expect((await app.fetch(post(guard.good, '{"wrong":1}'))).status).toBe(422)
      const ok = await app.fetch(post(guard.good, '{"name":"a"}'))
      expect(ok.status).toBe(200)
      expect(await ok.json()).not.toEqual({ principal: null })
    })

    test(`${guard.name} optional: no credentials still validates and runs with no principal`, async () => {
      const { install, principal } = guard.make(true)
      const { schema } = countingBody()
      const app = install(server()).post("/items", { body: schema }, (c) => ({
        principal: principal(c.req),
      }))
      expect((await app.fetch(post({}, '{"wrong":1}'))).status).toBe(422)
      const anonymous = await app.fetch(post({}, '{"name":"a"}'))
      expect(anonymous.status).toBe(200)
      expect(await anonymous.json()).toEqual({ principal: null })
      const signedIn = await app.fetch(post(guard.good, '{"name":"a"}'))
      expect(await signedIn.json()).not.toEqual({ principal: null })
    })
  }
})

describe("every route shape behind required auth", () => {
  const guard = () => bearer({ verify: (t) => (t === "good" ? { id: "u1" } : null) })
  const GOOD = { authorization: "Bearer good" }
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Request(`http://x${path}`, { headers })
  const query = {
    "~standard": {
      version: 1 as const,
      vendor: "auth-first-test",
      validate: (value: unknown) =>
        typeof value === "object" && value !== null && Reflect.get(value, "q") === "1"
          ? { value }
          : { issues: [{ message: "q must be 1", path: ["q"] }] },
    },
  }

  test("get, a query schema, all(), group(), implement() and a route before use()", async () => {
    const contract = defineContract({ me: { method: "GET", path: "/contract" } })
    const app = implement(
      contract,
      { me: () => ({ ok: true }) },
      server()
        .get("/before", () => ({ open: true }))
        .use(guard())
        .get("/plain", () => ({ ok: true }))
        .get("/query", { query }, () => ({ ok: true }))
        .use(all("/any", () => ({ ok: true })))
        .use(method("REPORT", "/report", () => ({ ok: true })))
        .group("/g", (g) => g.get("/x", () => ({ ok: true }))),
    )
    for (const path of ["/plain", "/query?q=2", "/any", "/g/x", "/contract"]) {
      expect([path, (await app.fetch(get(path))).status]).toEqual([path, 401])
    }
    const report = (headers: Record<string, string>) =>
      app.fetch(new Request("http://x/report", { method: "REPORT", headers }))
    expect((await report({})).status).toBe(401)
    expect((await report(GOOD)).status).toBe(200)
    expect((await app.fetch(get("/query?q=2", GOOD))).status).toBe(422)
    for (const path of ["/plain", "/query?q=1", "/any", "/g/x", "/contract"]) {
      expect([path, (await app.fetch(get(path, GOOD))).status]).toEqual([path, 200])
    }
    expect((await app.fetch(get("/before"))).status).toBe(200)
  })

  test("header, cookie and param schemas, sse, a merged group and a mounted child", async () => {
    const merged = server()
      .use(guard())
      .post("/merged", { body: t.object({ name: t.string() }) }, () => ({ ok: true }))
    const mounted = server()
      .use(guard())
      .get("/inner", () => ({ ok: true }))
    const app = server()
      .use(streaming())
      .use(guard())
      .get("/h", { headers: t.object({ "x-tenant": t.literal("a") }) }, () => ({ ok: true }))
      .get("/c", { cookies: t.object({ pref: t.literal("a") }) }, () => ({ ok: true }))
      .get("/p/:id", { params: t.object({ id: t.literal("1") }) }, () => ({ ok: true }))
      .sse("/events", { sse: t.object({ n: t.integer() }) }, (_c, stream) => {
        stream.send({ n: 1 })
        stream.close()
      })
      .merge(merged)
      .mount({ path: "/child", app: mounted, stripPrefix: true })
    const bad = { "x-tenant": "b", cookie: "pref=b" }
    for (const path of ["/h", "/c", "/p/2", "/events", "/child/inner"]) {
      expect([path, (await app.fetch(get(path, bad))).status]).toEqual([path, 401])
      const status = (await app.fetch(get(path, { ...GOOD, ...bad }))).status
      expect([path, status]).toEqual([
        path,
        path === "/events" || path === "/child/inner" ? 200 : 422,
      ])
    }
    const merge = (headers: Record<string, string>) =>
      app.fetch(post(headers, '{"wrong":1}', "/merged"))
    expect((await merge({})).status).toBe(401)
    expect((await merge(GOOD)).status).toBe(422)
    const evidence = reflectRoutes(app).find((route) => route.path === "/h")?.assurance ?? []
    expect(evidence).toContainEqual({
      id: "nifra.authenticated",
      source: "nifra.authenticate",
      provenance: "runtime",
    })
  })

  test("a WebSocket upgrade is refused without credentials and accepted with them", async () => {
    const app = server()
      .use(websocket())
      .use(guard())
      .ws("/socket", { upgrade: () => ({ user: "u1" }) })
    const upgrade = (headers: Record<string, string>) => {
      const resolve = app.resolveWebSocketUpgrade
      if (resolve === undefined) throw new Error("the server takes no upgrades")
      return resolve.call(
        app,
        new Request("http://x/socket", { headers: { upgrade: "websocket", ...headers } }),
      )
    }
    const refused = await upgrade({})
    expect(refused.kind === "reject" ? refused.response.status : refused.kind).toBe(401)
    expect((await upgrade(GOOD)).kind).toBe("upgrade")
  })

  test("requestId still marks a refused request on every lane", async () => {
    for (const [lane, send] of LANES) {
      const app = server()
        .use(nodeDirect())
        .use(requestId())
        .use(guard())
        .get("/plain", () => ({ ok: true }))
      const response = await send(app, get("/plain"))
      expect([lane, response.status]).toEqual([lane, 401])
      expect(response.headers.get("x-request-id")).toBeString()
      running?.stop(true)
      running = undefined
    }
  })
})
