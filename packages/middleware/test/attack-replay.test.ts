import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import {
  bodyLimit,
  cache,
  cors,
  csrf,
  ipRestriction,
  jwt,
  MemoryResponseCache,
  methodOverride,
  trimTrailingSlash,
} from "../src/index.ts"

/**
 * Hostile requests from attack classes that have broken other frameworks' middleware: CORS that
 * reflects any origin with credentials, a redirect that turns into a protocol-relative URL, a
 * method override that makes a cross-site GET unsafe, an IP rule an alternate address spelling
 * slips past, a body cap that trusts the declared length, a JWT check that trusts the token's own
 * header, a response cache that serves one visitor's page to another.
 */

type App = { fetch(request: Request): Response | Promise<Response> }
/** Bun and undici require `duplex` for a streaming request body; the DOM lib does not declare it. */
type StreamingInit = RequestInit & { readonly duplex: "half" }

const send = (app: App, path: string, init: RequestInit | StreamingInit = {}): Promise<Response> =>
  Promise.resolve(app.fetch(new Request(`http://app.example${path}`, init)))

describe("cors", () => {
  test("credentials with every origin is refused when the middleware is built", () => {
    expect(() => cors({ credentials: true })).toThrow("cannot be combined")
  })

  test("only a listed origin, spelled exactly, is allowed with credentials", async () => {
    const app = server()
      .use(cors({ origin: ["https://good.example"], credentials: true }))
      .get("/x", () => "ok")
    const allowed: string[] = []
    for (const origin of [
      "https://good.example",
      "https://good.example.evil.example",
      "https://evil.example?https://good.example",
      "https://good.example/",
      "https://good.example:443",
      "http://good.example",
      "HTTPS://GOOD.EXAMPLE",
      "null",
    ]) {
      const res = await send(app, "/x", { headers: { origin } })
      expect(res.headers.get("vary")).toBe("Origin")
      if (res.headers.get("access-control-allow-origin") !== null) allowed.push(origin)
    }
    expect(allowed).toEqual(["https://good.example"])
  })
})

describe("redirects", () => {
  test("a trailing-slash redirect never points at another host", async () => {
    const app = server()
      .use(trimTrailingSlash())
      .get("/a", () => "ok")
    const locations: Record<string, string | null> = {}
    for (const path of [
      "//evil.example/",
      "/\\evil.example/",
      "///evil.example//",
      "/%2F%2Fevil.example/",
      "/%5Cevil.example/",
    ])
      locations[path] = (await send(app, path)).headers.get("location")
    expect(locations).toEqual({
      "//evil.example/": "/.//evil.example",
      "/\\evil.example/": "/.//evil.example",
      "///evil.example//": "/.///evil.example",
      "/%2F%2Fevil.example/": "/%2F%2Fevil.example",
      "/%5Cevil.example/": "/%5Cevil.example",
    })
  })
})

describe("method override", () => {
  const app = server()
    .use(methodOverride())
    .get("/m", () => "get")
    .post("/m", () => "post")
    .delete("/m", () => "delete")

  test("a GET is never turned into a method that writes", async () => {
    for (const init of [
      { headers: { "x-http-method-override": "DELETE" } },
      { headers: { "x-http-method-override": "POST" } },
    ])
      expect(await (await send(app, "/m", init)).text()).toBe('"get"')
    expect(await (await send(app, "/m?_method=DELETE")).text()).toBe('"get"')
  })

  test("a POST cannot become a method outside the allowed set", async () => {
    for (const method of ["TRACE", "CONNECT", "GET"]) {
      const res = await send(app, "/m", {
        method: "POST",
        headers: { "x-http-method-override": method },
        body: "",
      })
      expect(res.status).toBe(400)
    }
  })
})

describe("ip restriction", () => {
  const status = async (ip: string, deny: string[]): Promise<number> =>
    (
      await send(
        server()
          .use(ipRestriction({ deny, clientIp: () => ip }))
          .get("/i", () => "in"),
        "/i",
      )
    ).status

  test("an IPv4 address in another spelling still meets a deny rule", async () => {
    for (const ip of [
      "10.0.0.1",
      "::ffff:10.0.0.1",
      "::FFFF:10.0.0.1",
      "::ffff:a00:1",
      "0:0:0:0:0:ffff:10.0.0.1",
      "0::ffff:10.0.0.1",
      "010.0.0.1",
      "0x0a.0.0.1",
      "167772161",
      "10.1",
      "10.0.0.1%eth0",
      "[10.0.0.1]",
      " 10.0.0.1",
    ])
      expect([ip, await status(ip, ["10.0.0.0/8"])]).toEqual([ip, 403])
  })

  test("a loopback address in another spelling still meets a deny rule", async () => {
    for (const ip of ["::1", "0:0:0:0:0:0:0:1", "::0001", "0::1", "::ffff:127.0.0.1"])
      expect([ip, await status(ip, ["::1", "127.0.0.1"])]).toEqual([ip, 403])
  })
})

describe("body limit", () => {
  const big = JSON.stringify({ x: "y".repeat(5_000) })
  const stream = (): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big))
        controller.close()
      },
    })
  const app = server()
    .use(bodyLimit({ maxBytes: 100 }))
    .post("/b", { body: t.json() }, () => "read")

  test("a body with no declared length is refused rather than read uncapped", async () => {
    const res = await send(app, "/b", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream(),
      duplex: "half",
    })
    expect(res.status).toBe(411)
  })

  test("a body longer than its declared length is refused, not trusted", async () => {
    const res = await send(app, "/b", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "10" },
      body: stream(),
      duplex: "half",
    })
    expect(res.status).toBe(413)
  })
})

describe("jwt", () => {
  const secret = "s".repeat(32)
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: string | Uint8Array): string => Buffer.from(value).toString("base64url")
  const sign = async (header: object, claims: object): Promise<string> => {
    const signed = `${encode(JSON.stringify(header))}.${encode(JSON.stringify(claims))}`
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed))
    return `${signed}.${encode(new Uint8Array(mac))}`
  }
  const app = server()
    .use(jwt({ key: secret, algorithms: ["HS256"] }))
    .get("/j", () => "in")
  const statusFor = async (authorization: string): Promise<number> =>
    (await send(app, "/j", { headers: { authorization } })).status

  test("a valid token is the control", async () => {
    expect(await statusFor(`Bearer ${await sign({ alg: "HS256" }, { exp: now + 60 })}`)).toBe(200)
  })

  test("a token cannot pick its own algorithm", async () => {
    const unsigned = `${encode('{"alg":"none"}')}.${encode(JSON.stringify({ exp: now + 60 }))}.`
    expect(await statusFor(`Bearer ${unsigned}`)).toBe(401)
    expect(await statusFor(`Bearer ${await sign({ alg: "HS512" }, { exp: now + 60 })}`)).toBe(401)
  })

  test("a token sent under another scheme is refused", async () => {
    const token = await sign({ alg: "HS256" }, { exp: now + 60 })
    expect(await statusFor(`Basic ${token}`)).toBe(401)
    expect(await statusFor(token)).toBe(401)
  })

  test("a time claim that is not a number is refused", async () => {
    expect(
      await statusFor(`Bearer ${await sign({ alg: "HS256" }, { exp: String(now - 60) })}`),
    ).toBe(401)
    expect(
      await statusFor(
        `Bearer ${await sign({ alg: "HS256" }, { exp: now + 60, nbf: String(now + 600) })}`,
      ),
    ).toBe(401)
  })
})

describe("csrf", () => {
  const app = server()
    .use(csrf({ secret: "0123456789abcdef0123456789abcdef" }))
    .post("/w", () => "wrote")
    .put("/w", () => "wrote")
    .delete("/w", () => "wrote")

  test("no origin claim or content type stands in for the token", async () => {
    for (const [method, headers] of [
      ["POST", {}],
      ["POST", { origin: "null" }],
      ["POST", { origin: "http://app.example" }],
      ["POST", { "sec-fetch-site": "same-origin" }],
      ["POST", { "content-type": "application/json", origin: "http://app.example" }],
      ["PUT", {}],
      ["DELETE", {}],
    ] as const)
      expect((await send(app, "/w", { method, headers, body: "x" })).status).toBe(403)
  })
})

describe("response cache", () => {
  const counted = () => {
    let renders = 0
    const app = server()
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000 }))
      .get("/me", (c) => ({
        render: ++renders,
        who: c.req.headers.get("authorization") ?? c.req.headers.get("cookie") ?? "anonymous",
      }))
      .get("/session", (c) => {
        c.set.cookie("sid", `s${++renders}`)
        return { render: renders }
      })
      .get("/private", (c) => {
        c.set.headers["cache-control"] = "private"
        return { render: ++renders }
      })
    return app
  }
  const json = async (res: Response): Promise<unknown> => res.json()

  test("a visitor's credentials never write or read a shared entry", async () => {
    const app = counted()
    expect(await json(await send(app, "/me", { headers: { authorization: "alice" } }))).toEqual({
      render: 1,
      who: "alice",
    })
    expect(await json(await send(app, "/me"))).toEqual({ render: 2, who: "anonymous" })
    expect(await json(await send(app, "/me", { headers: { cookie: "u=carol" } }))).toEqual({
      render: 3,
      who: "u=carol",
    })
    expect(await json(await send(app, "/me"))).toEqual({ render: 2, who: "anonymous" })
  })

  test("a response that sets a cookie or says private is never stored", async () => {
    const app = counted()
    const first = await send(app, "/session")
    const second = await send(app, "/session")
    expect(first.headers.get("set-cookie")).not.toBe(second.headers.get("set-cookie"))
    expect(await json(await send(app, "/private"))).toEqual({ render: 3 })
    expect(await json(await send(app, "/private"))).toEqual({ render: 4 })
  })
})
