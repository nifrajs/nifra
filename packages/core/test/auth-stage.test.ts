import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { NIFRA_ASSURANCE } from "../src/assurance.ts"
import { authenticated, rejected, server, status } from "../src/index.ts"
import { reflectRoutes } from "../src/reflection.ts"

describe("dedicated authentication stage", () => {
  test("rejects before reading or validating an unauthenticated body", async () => {
    let validations = 0
    let bodyReads = 0
    const bodySchema = {
      "~standard": {
        version: 1,
        vendor: "auth-stage-test",
        validate(value: unknown) {
          validations += 1
          return t.object({ name: t.string() })["~standard"].validate(value)
        },
      },
    } as const
    const app = server()
      .authenticate({
        id: "test-auth",
        mode: "sync",
        run(input) {
          expect("req" in input).toBe(false)
          expect("body" in input).toBe(false)
          expect("query" in input).toBe(false)
          expect("raw" in input).toBe(false)
          expect(Object.isFrozen(input)).toBe(true)
          expect(Object.isFrozen(input.headers)).toBe(true)
          expect(input.headers.has("authorization")).toBe(
            input.headers.get("authorization") !== null,
          )
          const headerNames: string[] = []
          input.headers.forEach((_value, name) => {
            headerNames.push(name)
          })
          expect(headerNames).toContain("content-type")
          return input.headers.get("authorization") === "Bearer good"
            ? authenticated({ userId: "u1" })
            : rejected()
        },
      })
      .post("/private", { body: bodySchema }, (c) => ({ id: c.principal.userId, body: c.body }))

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"))
        controller.close()
      },
      pull() {
        bodyReads += 1
      },
    })
    const response = await app.fetch(
      new Request("http://x/private", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        // Bun and undici require this for a streaming request body.
        duplex: "half",
      } as RequestInit),
    )

    expect(response.status).toBe(401)
    expect(validations).toBe(0)
    expect(bodyReads).toBe(0)
  })

  test("validates after authentication and exposes the principal", async () => {
    let validations = 0
    const bodySchema = {
      "~standard": {
        version: 1,
        vendor: "auth-stage-test",
        validate(value: unknown) {
          validations += 1
          return t.object({ name: t.string() })["~standard"].validate(value)
        },
      },
    } as const
    const app = server()
      .authenticate({
        id: "test-auth",
        mode: "sync",
        run(input) {
          return input.headers.get("authorization") === "Bearer good"
            ? authenticated({ userId: "u1" })
            : rejected()
        },
      })
      .post("/private", { body: bodySchema }, (c) => ({ id: c.principal.userId, body: c.body }))

    const invalid = await app.fetch(
      new Request("http://x/private", {
        method: "POST",
        headers: {
          authorization: "Bearer good",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    )
    expect(invalid.status).toBe(422)
    expect(validations).toBe(1)

    const valid = await app.fetch(
      new Request("http://x/private", {
        method: "POST",
        headers: {
          authorization: "Bearer good",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Ada" }),
      }),
    )
    expect(valid.status).toBe(200)
    expect(await valid.json()).toEqual({ id: "u1", body: { name: "Ada" } })
  })

  test("fails closed when an authentication stage throws or returns an invalid decision", async () => {
    const throwing = server()
      .authenticate({ id: "throwing", run: () => Promise.reject(new Error("provider down")) })
      .get("/private", () => ({ ok: true }))
    const invalid = server()
      .authenticate({ id: "invalid", run: () => undefined as never })
      .get("/private", () => ({ ok: true }))
    const invalidPrincipal = server()
      .authenticate({ id: "invalid-principal", run: () => authenticated(null as never) })
      .get("/private", () => ({ ok: true }))
    const invalidResponse = server()
      .authenticate({
        id: "invalid-response",
        run: () => rejected("unauthenticated", { invalid: true } as never),
      })
      .get("/private", () => ({ ok: true }))

    expect((await throwing.fetch(new Request("http://x/private"))).status).toBe(503)
    expect((await invalid.fetch(new Request("http://x/private"))).status).toBe(503)
    expect((await invalidPrincipal.fetch(new Request("http://x/private"))).status).toBe(503)
    expect((await invalidResponse.fetch(new Request("http://x/private"))).status).toBe(503)
  })

  test("explicit validate-before-auth preserves the legacy order", async () => {
    let authCalls = 0
    let validations = 0
    const bodySchema = {
      "~standard": {
        version: 1 as const,
        vendor: "auth-stage-order-test",
        validate(value: unknown) {
          validations += 1
          return t.object({ name: t.string() })["~standard"].validate(value)
        },
      },
    }
    const app = server()
      .authenticate({
        id: "order-test",
        mode: "sync",
        run() {
          authCalls += 1
          return authenticated({ userId: "u1" })
        },
      })
      .post("/private", { validationOrder: "validate-before-auth", body: bodySchema }, () => ({
        ok: true,
      }))

    const response = await app.fetch(
      new Request("http://x/private", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(response.status).toBe(422)
    expect(validations).toBe(1)
    expect(authCalls).toBe(0)
  })

  test("protected fast lane continues through async auth and body validation", async () => {
    let authCalls = 0
    const bodySchema = {
      "~standard": {
        version: 1 as const,
        vendor: "auth-stage-async-test",
        validate(value: unknown) {
          return Promise.resolve(t.object({ name: t.string() })["~standard"].validate(value))
        },
      },
    }
    const app = server()
      .authenticate({
        id: "async-test",
        mode: "async",
        run: async () => {
          authCalls += 1
          return authenticated({ userId: "u1" })
        },
      })
      .post("/private", { body: bodySchema }, (c) => ({ id: c.principal.userId, body: c.body }))

    const response = await app.fetch(
      new Request("http://x/private", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    )
    expect(response.status).toBe(200)
    expect(authCalls).toBe(1)
    expect(await response.json()).toEqual({ id: "u1", body: { name: "Ada" } })
  })

  test("protected fast lane validates query input after authentication", async () => {
    const app = server()
      .authenticate({ id: "query-test", run: () => authenticated({ userId: "u1" }) })
      .get("/search", { query: t.object({ q: t.string({ minLength: 1 }) }) }, (c) => ({
        userId: c.principal.userId,
        query: c.query.q,
      }))

    expect((await app.fetch(new Request("http://x/search"))).status).toBe(422)
    const response = await app.fetch(new Request("http://x/search?q=sample"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ userId: "u1", query: "sample" })
  })

  test("authenticate() publishes runtime authenticated assurance evidence", () => {
    const app = server()
      .authenticate({ id: "assurance-test", run: () => authenticated({ userId: "u1" }) })
      .get("/private", () => ({ ok: true }))
    expect(reflectRoutes(app)[0]?.assurance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: NIFRA_ASSURANCE.AUTHENTICATED, provenance: "runtime" }),
      ]),
    )
  })

  test("normalizes policy failures, provider throws, and integration responses", async () => {
    const forbidden = server()
      .authenticate({ id: "forbidden", run: () => rejected("forbidden") })
      .get("/private", () => ({ ok: true }))
    const unavailable = server()
      .authenticate({ id: "unavailable", run: () => rejected("unavailable") })
      .get("/private", () => ({ ok: true }))
    const redirect = server()
      .authenticate({
        id: "redirect",
        run: () => rejected("unauthenticated", new Response("login", { status: 302 })),
      })
      .get("/private", () => ({ ok: true }))
    const result = server()
      .authenticate({
        id: "result",
        run: () => rejected("unauthenticated", status(418, { ok: false })),
      })
      .get("/private", () => ({ ok: true }))
    const throwing = server()
      .authenticate({
        id: "sync-throw",
        run: () => {
          throw new Error("provider failure")
        },
      })
      .get("/private", () => ({ ok: true }))
    const invalidReason = server()
      .authenticate({
        id: "invalid-reason",
        run: () => ({ kind: "rejected", reason: "invalid" }) as never,
      })
      .get("/private", () => ({ ok: true }))

    expect((await forbidden.fetch(new Request("http://x/private"))).status).toBe(403)
    expect((await unavailable.fetch(new Request("http://x/private"))).status).toBe(503)
    expect((await redirect.fetch(new Request("http://x/private"))).status).toBe(302)
    expect((await result.fetch(new Request("http://x/private"))).status).toBe(418)
    expect((await throwing.fetch(new Request("http://x/private"))).status).toBe(503)
    expect((await invalidReason.fetch(new Request("http://x/private"))).status).toBe(503)
  })

  test("recurses through auth stages and keeps validation order fail closed", async () => {
    let authCalls = 0
    const body = t.object({ name: t.string() })
    const app = server()
      .authenticate({
        id: "first",
        run: () => {
          authCalls++
          return authenticated({ first: true })
        },
      })
      .authenticate({
        id: "second",
        run: () => {
          authCalls++
          return authenticated({ userId: "u1" })
        },
      })
      .post("/ordered", { body, validationOrder: "validate-before-auth" }, (c) => ({
        id: c.principal.userId,
        name: c.body.name,
      }))

    const invalid = await app.fetch(
      new Request("http://x/ordered", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(invalid.status).toBe(422)
    expect(authCalls).toBe(0)

    const valid = await app.fetch(
      new Request("http://x/ordered", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    )
    expect(valid.status).toBe(200)
    expect(await valid.json()).toEqual({ id: "u1", name: "Ada" })
    expect(authCalls).toBe(2)

    const protectedInvalid = server()
      .authenticate({ id: "protected", run: () => authenticated({ userId: "u1" }) })
      .post("/protected", { body }, (c) => ({ name: c.body.name }))
    const rejectedBody = await protectedInvalid.fetch(
      new Request("http://x/protected", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(rejectedBody.status).toBe(422)
  })

  test("covers non-fast authenticated lanes and bounded body failures", async () => {
    const body = t.object({ name: t.string() })
    const derived = server()
      .authenticate({ id: "derived", run: () => authenticated({ userId: "u1" }) })
      .derive(() => ({ marker: "derived" }))
      .post("/derived", { body, validationOrder: "validate-before-auth" }, (c) => ({
        id: c.principal.userId,
        marker: c.marker,
        name: c.body.name,
      }))
    const derivedResponse = await derived.fetch(
      new Request("http://x/derived", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    )
    expect(derivedResponse.status).toBe(200)
    expect(await derivedResponse.json()).toEqual({ id: "u1", marker: "derived", name: "Ada" })

    const defaultOrder = server()
      .authenticate({ id: "derived-default", run: () => authenticated({ userId: "u1" }) })
      .derive(() => ({ marker: "default" }))
      .get("/derived-default", (c) => ({ id: c.principal.userId, marker: c.marker }))
    expect((await defaultOrder.fetch(new Request("http://x/derived-default"))).status).toBe(200)

    const queryBeforeAuth = server()
      .authenticate({ id: "query-before", run: () => authenticated({ userId: "u1" }) })
      .get(
        "/query-before",
        { validationOrder: "validate-before-auth", query: t.object({ q: t.string() }) },
        () => ({ ok: true }),
      )
    expect((await queryBeforeAuth.fetch(new Request("http://x/query-before"))).status).toBe(422)
    expect(
      (await queryBeforeAuth.fetch(new Request("http://x/query-before?q=sample"))).status,
    ).toBe(200)

    const asyncQueryBeforeAuth = server()
      .authenticate({
        id: "async-query-before",
        mode: "async",
        run: async () => authenticated({ userId: "u1" }),
      })
      .get(
        "/async-query-before",
        { validationOrder: "validate-before-auth", query: t.object({ q: t.string() }) },
        () => ({ ok: true }),
      )
    expect(
      (await asyncQueryBeforeAuth.fetch(new Request("http://x/async-query-before?q=sample")))
        .status,
    ).toBe(200)

    const brokenBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("broken body stream"))
      },
    })
    const fastFailure = server()
      .authenticate({ id: "fast-body-failure", run: () => authenticated({ userId: "u1" }) })
      .post("/fast-failure", { body }, () => ({ ok: true }))
    const fastFailureResponse = await fastFailure.fetch(
      new Request("http://x/fast-failure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: brokenBody,
        duplex: "half",
      } as RequestInit),
    )
    expect(fastFailureResponse.status).toBe(500)

    const brokenValidationBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("broken validation stream"))
      },
    })
    const validationFailure = server()
      .authenticate({ id: "validation-body-failure", run: () => authenticated({ userId: "u1" }) })
      .post("/validation-failure", { body, validationOrder: "validate-before-auth" }, () => ({
        ok: true,
      }))
    const validationFailureResponse = await validationFailure.fetch(
      new Request("http://x/validation-failure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: brokenValidationBody,
        duplex: "half",
      } as RequestInit),
    )
    expect(validationFailureResponse.status).toBe(500)
  })

  test("runs the explicit auth-before-validation lifecycle lane", async () => {
    const body = t.object({ name: t.string() })
    const app = server()
      .derive(async () => ({ marker: "derived" }))
      .beforeHandle(async () => undefined)
      .afterHandle(async (value) => value)
      .post("/legacy-order", { body, validationOrder: "auth-before-validation" }, async (c) => ({
        marker: c.marker,
        name: c.body.name,
      }))
    const response = await app.fetch(
      new Request("http://x/legacy-order", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ marker: "derived", name: "Ada" })

    const failing = server()
      .beforeHandle(() => {
        throw new Error("private before detail")
      })
      .get("/legacy-error", { validationOrder: "auth-before-validation" }, () => ({ ok: true }))
    const failed = await failing.fetch(new Request("http://x/legacy-error"))
    expect(failed.status).toBe(500)
    expect(await failed.text()).not.toContain("private before detail")
  })

  test("protected fast lane supports async handlers and maps handler errors", async () => {
    const app = server()
      .authenticate({ id: "handler", run: () => authenticated({ userId: "u1" }) })
      .get("/async", async () => ({ ok: true }))
      .get("/boom", () => {
        throw new Error("private handler detail")
      })
      .get("/async-boom", async () => {
        throw new Error("private async handler detail")
      })

    expect((await app.fetch(new Request("http://x/async"))).status).toBe(200)
    const failed = await app.fetch(new Request("http://x/boom"))
    expect(failed.status).toBe(500)
    expect(await failed.text()).not.toContain("private handler detail")
    const asyncFailed = await app.fetch(new Request("http://x/async-boom"))
    expect(asyncFailed.status).toBe(500)
    expect(await asyncFailed.text()).not.toContain("private async handler detail")
  })
})
