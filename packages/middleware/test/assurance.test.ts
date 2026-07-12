import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { NIFRA_ASSURANCE } from "@nifrajs/core/assurance"
import {
  basicAuth,
  bearer,
  bodyLimit,
  csrf,
  idempotency,
  ipRestriction,
  jwt,
  MemoryIdempotencyStore,
  MemoryStore,
  rateLimit,
  securityHeaders,
} from "../src/index.ts"

const ids = (app: ReturnType<typeof server>, path: string): readonly string[] =>
  app
    .routes()
    .find((route) => route.path === path)
    ?.assurance?.map((item) => item.id) ?? []

describe("official route assurance evidence", () => {
  test("global hardening is method-accurate and authentication stays order-scoped", () => {
    const app = server()
      .post("/before", () => ({ ok: true }))
      .use(securityHeaders())
      .use(rateLimit({ store: new MemoryStore(), max: 10, windowMs: 1_000, key: () => "test" }))
      .use(csrf({ secret: "0123456789abcdef0123456789abcdef" }))
      .use(idempotency({ store: new MemoryIdempotencyStore() }))
      .use(bodyLimit({ maxBytes: 1_024 }))
      .use(ipRestriction({ allow: ["127.0.0.1"], clientIp: () => "127.0.0.1" }))
      .get("/public", () => ({ ok: true }))
      .use(bearer({ verify: (token) => (token === "ok" ? { id: "u1" } : null) }))
      .get("/private", () => ({ ok: true }))
      .post("/mutation", () => ({ ok: true }))

    expect(ids(app, "/before")).toEqual([
      NIFRA_ASSURANCE.SECURITY_HEADERS,
      NIFRA_ASSURANCE.RATE_LIMITED,
      NIFRA_ASSURANCE.CSRF,
      NIFRA_ASSURANCE.IDEMPOTENCY_KEY,
      NIFRA_ASSURANCE.BODY_BOUNDED,
      NIFRA_ASSURANCE.IP_RESTRICTED,
    ])
    expect(ids(app, "/public")).toEqual([
      NIFRA_ASSURANCE.SECURITY_HEADERS,
      NIFRA_ASSURANCE.RATE_LIMITED,
      NIFRA_ASSURANCE.IP_RESTRICTED,
    ])
    expect(ids(app, "/private")).toEqual([
      NIFRA_ASSURANCE.AUTHENTICATED,
      NIFRA_ASSURANCE.SECURITY_HEADERS,
      NIFRA_ASSURANCE.RATE_LIMITED,
      NIFRA_ASSURANCE.IP_RESTRICTED,
    ])
    expect(ids(app, "/mutation")).toContain(NIFRA_ASSURANCE.AUTHENTICATED)
    expect(ids(app, "/mutation")).toContain(NIFRA_ASSURANCE.CSRF)
  })

  test("optional authentication never emits authenticated evidence", () => {
    const app = server()
      .use(bearer({ verify: () => null, optional: true }))
      .get("/bearer", () => ({}))
      .use(basicAuth({ username: "u", password: "p", optional: true }))
      .get("/basic", () => ({}))
      .use(
        jwt({
          key: "0123456789abcdef0123456789abcdef",
          algorithms: ["HS256"],
          optional: true,
        }),
      )
      .get("/jwt", () => ({}))

    expect(ids(app, "/bearer")).not.toContain(NIFRA_ASSURANCE.AUTHENTICATED)
    expect(ids(app, "/basic")).not.toContain(NIFRA_ASSURANCE.AUTHENTICATED)
    expect(ids(app, "/jwt")).not.toContain(NIFRA_ASSURANCE.AUTHENTICATED)
  })

  test("basic and jwt authentication emit the same canonical evidence", () => {
    const basic = server()
      .use(basicAuth({ username: "u", password: "p" }))
      .get("/basic", () => ({}))
    const bearerJwt = server()
      .use(
        jwt({
          key: "0123456789abcdef0123456789abcdef",
          algorithms: ["HS256"],
        }),
      )
      .get("/jwt", () => ({}))

    expect(ids(basic, "/basic")).toContain(NIFRA_ASSURANCE.AUTHENTICATED)
    expect(ids(bearerJwt, "/jwt")).toContain(NIFRA_ASSURANCE.AUTHENTICATED)
  })

  test("evidence stays honest for lengthless bodies and non-router method configuration", () => {
    const lengthless = server()
      .use(bodyLimit({ maxBytes: 1_024, allowLengthless: true }))
      .post("/upload", () => ({}))
    expect(ids(lengthless, "/upload")).not.toContain(NIFRA_ASSURANCE.BODY_BOUNDED)

    const customMethods = server()
      .use(csrf({ secret: "0123456789abcdef0123456789abcdef", methods: ["TRACE", "POST"] }))
      .use(bodyLimit({ maxBytes: 1_024, methods: ["CONNECT", "POST"] }))
      .use(idempotency({ store: new MemoryIdempotencyStore(), methods: ["TRACE", "POST"] }))
      .post("/mutation", () => ({}))
    expect(ids(customMethods, "/mutation")).toEqual([
      NIFRA_ASSURANCE.CSRF,
      NIFRA_ASSURANCE.BODY_BOUNDED,
      NIFRA_ASSURANCE.IDEMPOTENCY_KEY,
    ])
  })
})
