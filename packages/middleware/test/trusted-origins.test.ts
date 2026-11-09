import { describe, expect, test } from "bun:test"
import { type StandardSchemaV1, server } from "@nifrajs/core"
import { cors } from "../src/cors.ts"
import { createCsrfToken, csrf } from "../src/csrf.ts"

const FORM = "application/x-www-form-urlencoded"
const SECRET = "x".repeat(32)

const send = (
  contentType: string | null,
  headers: Record<string, string> = {},
  method = "POST",
): Request => {
  const all = new Headers(headers)
  if (contentType !== null) all.set("content-type", contentType)
  return new Request("http://app.test/f", { method, headers: all, body: "a=1" })
}

const bodyless = () => server().post("/f", () => ({ ok: true }))
const status = async (app: { fetch(r: Request): Promise<Response> | Response }, r: Request) =>
  (await app.fetch(r)).status

describe("cors() origins are trusted for form posts", () => {
  test("a listed origin passes without a second list in formOrigins; others stay refused", async () => {
    const app = bodyless().use(cors({ origin: ["https://app.example"] }))
    expect(await status(app, send(FORM, { origin: "https://app.example" }))).toBe(200)
    expect(
      await status(app, send("multipart/form-data; boundary=b", { origin: "https://app.example" })),
    ).toBe(200)
    expect(await status(app, send(FORM, { origin: "https://evil.test" }))).toBe(403)
  })

  test("a single origin and a predicate work the same way", async () => {
    const one = bodyless().use(cors({ origin: "https://app.example" }))
    expect(await status(one, send(FORM, { origin: "https://app.example" }))).toBe(200)
    expect(await status(one, send(FORM, { origin: "https://evil.test" }))).toBe(403)
    const fn = bodyless().use(cors({ origin: (o) => o.endsWith(".example") }))
    expect(await status(fn, send(FORM, { origin: "https://a.example" }))).toBe(200)
    expect(await status(fn, send(FORM, { origin: "https://evil.test" }))).toBe(403)
  })

  test('"*" and the default trust nothing extra', async () => {
    for (const middleware of [cors(), cors({ origin: "*" })]) {
      const app = bodyless().use(middleware)
      expect(await status(app, send(FORM, { origin: "https://evil.test" }))).toBe(403)
    }
  })

  test("registering cors() after the route still applies, and a formOrigins list is kept", async () => {
    const app = server({ formOrigins: ["https://idp.test"] })
      .post("/f", () => ({ ok: true }))
      .use(cors({ origin: ["https://app.example"] }))
    expect(await status(app, send(FORM, { origin: "https://idp.test" }))).toBe(200)
    expect(await status(app, send(FORM, { origin: "https://app.example" }))).toBe(200)
    expect(await status(app, send(FORM, { origin: "https://evil.test" }))).toBe(403)
  })

  test("a body-schema route trusts the listed origin too", async () => {
    const schema: StandardSchemaV1<unknown, unknown> = {
      "~standard": { version: 1, vendor: "t", validate: (value) => ({ value }) },
    }
    const app = server()
      .use(cors({ origin: ["https://app.example"] }))
      .post("/f", { body: schema }, () => ({ ok: true }))
    expect(await status(app, send(FORM, { origin: "https://app.example" }))).toBe(200)
    expect(await status(app, send(FORM, { origin: "https://evil.test" }))).toBe(403)
  })
})

describe("csrf() origins are trusted for form posts", () => {
  test("a listed origin passes core's form check on a route csrf() does not guard", async () => {
    const app = bodyless().use(
      csrf({ secret: SECRET, methods: ["DELETE"], origins: ["https://admin.test"] }),
    )
    expect(await status(app, send(FORM, { origin: "https://admin.test" }))).toBe(200)
    expect(await status(app, send(FORM, { origin: "https://evil.test" }))).toBe(403)
  })

  test("without origins the same-origin default adds nothing", async () => {
    const app = bodyless().use(csrf({ secret: SECRET, methods: ["DELETE"] }))
    expect(await status(app, send(FORM, { origin: "https://admin.test" }))).toBe(403)
  })

  test("a token-bearing cross-origin DELETE with no content type from a listed origin passes", async () => {
    const token = await createCsrfToken(SECRET)
    const app = server()
      .use(csrf({ secret: SECRET, methods: ["DELETE"], origins: ["https://admin.test"] }))
      .delete("/f", () => ({ ok: true }))
    const headers = {
      origin: "https://admin.test",
      cookie: `csrf-token=${encodeURIComponent(token)}`,
      "x-csrf-token": token,
    }
    expect(await status(app, send(null, headers, "DELETE"))).toBe(200)
  })
})

describe("a post with no content type", () => {
  test("is refused from an origin nothing trusts, and passes from a trusted one or with Authorization", async () => {
    const app = bodyless().use(cors({ origin: ["https://app.example"] }))
    expect(await status(app, send(null, { origin: "https://evil.test" }))).toBe(403)
    expect(await status(app, send(null, { origin: "https://app.example" }))).toBe(200)
    expect(
      await status(app, send(null, { origin: "https://evil.test", authorization: "Bearer t" })),
    ).toBe(200)
    expect(await status(app, send(null, {}))).toBe(200)
  })

  test("a browser-managed Authorization scheme does not stand in for a preflight", async () => {
    const app = bodyless().use(cors({ origin: ["https://app.example"] }))
    const evil = { origin: "https://evil.test" }
    for (const authorization of ["Basic dTpw", "digest realm=x", "Negotiate abc", "NTLM abc"]) {
      expect(await status(app, send(null, { ...evil, authorization }))).toBe(403)
    }
    for (const authorization of ["Bearer t", "DPoP t", "Basically t", "opaque-key"]) {
      expect(await status(app, send(null, { ...evil, authorization }))).toBe(200)
    }
    expect(
      await status(app, send(null, { origin: "https://app.example", authorization: "Basic dTpw" })),
    ).toBe(200)
  })
})

describe("a mounted server", () => {
  test("keeps its own trusted origins out of the parent's form policy", async () => {
    const child = bodyless().use(cors({ origin: ["https://app.example"] }))
    const parent = server().merge(child)
    const listed = server({ formOrigins: ["https://app.example"] }).merge(child)
    const origin = { origin: "https://app.example" }
    expect(await status(child, send(FORM, origin))).toBe(200)
    expect(await status(parent, send(FORM, origin))).toBe(403)
    expect(await status(listed, send(FORM, origin))).toBe(200)
  })
})
