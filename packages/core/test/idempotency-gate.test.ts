import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { type IdempotencyStore, MemoryIdempotencyStore } from "../src/idempotency.ts"
import { idempotency } from "../src/idempotency-plugin.ts"
import { authenticated, rejected, server } from "../src/index.ts"
import {
  createTransportCodecRegistry,
  encodeTransportResponse,
  plainJsonCodec,
} from "../src/transport-codec.ts"
import { richWireCodec } from "../src/transport-codec-rich.ts"
import { transportCodecs } from "../src/transport-plugin.ts"

/** A length-less body that hands over a chunk on every pull and never ends. */
function endlessPost(
  url: string,
  headers: Record<string, string>,
  cancellation: "resolve" | "reject" | "pending" = "resolve",
) {
  let chunks = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks++
      controller.enqueue(new TextEncoder().encode(" "))
    },
    cancel() {
      cancelled = true
      if (cancellation === "reject")
        return Promise.reject(new Error("producer cancellation failed"))
      if (cancellation === "pending") return new Promise<void>(() => {})
      return undefined
    },
  })
  const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body, duplex: "half" }
  const request = new Request(url, init)
  return { request, chunks: () => chunks, cancelled: () => cancelled }
}

describe("the idempotency gate runs inside the route program", () => {
  for (const mode of ["authentication", "key", "limit", "deadline", "hook-read"] as const) {
    test(`cancels the request producer after ${mode} refusal`, async () => {
      const app = server({ maxBodyBytes: 4, requestTimeoutMs: mode === "deadline" ? 1 : 0 }).use(
        idempotency(),
      )
      if (mode === "authentication") app.authenticate({ id: "deny", run: () => rejected() })
      if (mode === "hook-read")
        app.beforeHandle(async (c) => {
          await c.req.text()
        })
      app.post(
        "/pay",
        {
          validationOrder:
            mode === "hook-read" || mode === "authentication"
              ? "auth-before-validation"
              : "validate-before-auth",
          idempotency: {
            scope: "request",
            namespace: () =>
              mode === "deadline" ? new Promise<string>(() => {}) : "principal:pay",
          },
        },
        () => "charged",
      )
      const input = endlessPost(
        "http://test/pay",
        mode === "key" ? {} : { "idempotency-key": "cleanup" },
      )
      const response = await app.fetch(input.request)
      expect(response.status).toBe(
        mode === "authentication" ? 401 : mode === "key" ? 400 : mode === "deadline" ? 503 : 413,
      )
      await Bun.sleep(0)
      expect(input.cancelled()).toBe(true)
      expect(input.request.body?.locked).toBe(false)
    })
  }

  for (const cancellation of ["reject", "pending"] as const) {
    test(`a ${cancellation} producer cancellation cannot hold up a refusal`, async () => {
      const app = server()
        .use(idempotency())
        .post(
          "/pay",
          {
            idempotency: { scope: "request", namespace: "public:pay" },
          },
          () => "charged",
        )
      const input = endlessPost("http://test/pay", {}, cancellation)
      const response = await app.fetch(input.request)
      expect(response.status).toBe(400)
      expect(input.cancelled()).toBe(true)
      expect(input.request.body?.locked).toBe(false)
      await Bun.sleep(0)
    })
  }

  test("bodyless idempotent requests complete and replay without a producer", async () => {
    let runs = 0
    const app = server()
      .use(idempotency())
      .post(
        "/pay",
        {
          idempotency: { scope: "request", namespace: "public:pay" },
        },
        () => {
          runs++
          return "charged"
        },
      )
    for (let i = 0; i < 2; i++) {
      const response = await app.fetch(
        new Request("http://test/pay", {
          method: "POST",
          headers: { "idempotency-key": "bodyless" },
        }),
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toBe("charged")
    }
    expect(runs).toBe(1)
  })

  test("an errored request producer reaches the error hook and releases its reader", async () => {
    const problem = new Error("producer failed")
    let caught: unknown
    const app = server()
      .use(idempotency())
      .onError((error) => {
        caught = error
        return new Response(null, { status: 502 })
      })
      .post(
        "/pay",
        {
          idempotency: { scope: "request", namespace: "public:pay" },
        },
        () => "charged",
      )
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(problem)
      },
    })
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "idempotency-key": "broken" },
      body,
      duplex: "half",
    }
    const request = new Request("http://test/pay", init)
    const response = await app.fetch(request)
    expect(response.status).toBe(502)
    expect(caught).toBe(problem)
    expect(request.body?.locked).toBe(false)
  })

  test("a handler retaining a locked body reader does not retain the original reader", async () => {
    let retained: ReadableStreamDefaultReader<Uint8Array> | undefined
    const app = server()
      .use(idempotency())
      .post(
        "/pay",
        {
          idempotency: { scope: "request", namespace: "public:pay" },
        },
        (c) => {
          retained = c.req.body?.getReader()
          return { charged: true }
        },
      )
    const request = new Request("http://test/pay", {
      method: "POST",
      headers: { "idempotency-key": "locked" },
      body: "finite",
    })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ charged: true })
    expect(request.body?.locked).toBe(false)
    retained?.releaseLock()
    await Bun.sleep(0)
  })

  for (const order of ["default", "authenticate", "policy"] as const) {
    for (const failure of ["namespace", "store"] as const) {
      test(`${order} program reports a failed ${failure} through onError`, async () => {
        const problem = new Error("idempotency unavailable")
        let caught: unknown
        const app = server()
          .use(idempotency())
          .onError((error) => {
            caught = error
            return new Response("unavailable", { status: 502 })
          })
        if (order === "authenticate")
          app.authenticate({ id: "ok", run: () => authenticated({ id: "u" }) })
        const store: IdempotencyStore = Object.assign(new MemoryIdempotencyStore(), {
          begin: () => Promise.reject(problem),
        })
        app.post(
          "/pay",
          {
            validationOrder:
              order === "default" ? "validate-before-auth" : "auth-before-validation",
            idempotency: {
              scope: "request",
              namespace: () => {
                if (failure === "namespace") throw problem
                return "principal:u"
              },
              store,
            },
          },
          () => "charged",
        )
        const response = await app.fetch(
          new Request("http://test/pay", {
            method: "POST",
            headers: { "idempotency-key": "failed" },
            body: "{}",
          }),
        )
        expect(response.status).toBe(502)
        expect(caught).toBe(problem)
      })
    }

    test(`${order} program meets a throwing onError once for a handler failure`, async () => {
      const problem = new Error("hook failed")
      let calls = 0
      const app = server()
        .use(idempotency())
        .onError(() => {
          calls++
          throw problem
        })
      if (order === "authenticate")
        app.authenticate({ id: "ok", run: () => authenticated({ id: "u" }) })
      app.post(
        "/pay",
        {
          validationOrder: order === "default" ? "validate-before-auth" : "auth-before-validation",
          idempotency: { scope: "request", namespace: () => "principal:u" },
        },
        () => {
          throw new Error("handler failed")
        },
      )
      const request = new Request("http://test/pay", {
        method: "POST",
        headers: { "idempotency-key": "hook" },
        body: "{}",
      })
      const response = await app.fetch(request)
      expect(response.status).toBe(500)
      expect(calls).toBe(1)
    })
  }
  test("an auth-first route refuses a bad credential before the gate reads the body", async () => {
    let authCalls = 0
    const app = server()
      .use(idempotency())
      .authenticate({
        id: "bearer",
        run: () => {
          authCalls++
          return rejected()
        },
      })
      .post(
        "/pay",
        {
          bodyLimit: 1024,
          body: t.object({ amount: t.number() }),
          idempotency: { scope: "request", namespace: () => "principal:any" },
        },
        () => "charged",
      )
    const { request, chunks } = endlessPost("http://test/pay", {
      "content-type": "application/json",
      "idempotency-key": "k1",
      authorization: "Bearer forged",
    })
    const response = await app.fetch(request)
    expect(response.status).toBe(401)
    expect(authCalls).toBe(1)
    // At most the runtime's own read-ahead; draining to the cap would have answered 413.
    expect(chunks()).toBeLessThanOrEqual(2)
  })

  test("a valid credential still reaches the handler with the full body", async () => {
    const app = server()
      .use(idempotency())
      .authenticate({ id: "bearer", run: () => authenticated({ id: "u1" }) })
      .post(
        "/pay",
        {
          body: t.object({ amount: t.number() }),
          idempotency: { scope: "request", namespace: () => "principal:u1" },
        },
        (c) => ({ amount: c.body.amount }),
      )
    const send = (amount: number) =>
      app.fetch(
        new Request("http://test/pay", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "k2" },
          body: JSON.stringify({ amount }),
        }),
      )
    const first = await send(5)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ amount: 5 })
    expect((await send(5)).headers.get("x-nifra-idempotent-replay")).toBe("1")
    expect((await send(6)).status).toBe(409)
  })

  test("a policy hook on an auth-first route refuses before the gate reads the body", async () => {
    const app = server()
      .use(idempotency())
      .beforeHandle((c) =>
        c.req.headers.get("authorization") === "Bearer good"
          ? undefined
          : new Response(null, { status: 401 }),
      )
      .post(
        "/pay",
        {
          bodyLimit: 1024,
          body: t.object({ amount: t.number() }),
          validationOrder: "auth-before-validation",
          idempotency: { scope: "request", namespace: "public:pay" },
        },
        (c) => ({ amount: c.body.amount }),
      )
    const { request, chunks } = endlessPost("http://test/pay", {
      "content-type": "application/json",
      "idempotency-key": "k4",
      authorization: "Bearer forged",
    })
    expect((await app.fetch(request)).status).toBe(401)
    expect(chunks()).toBeLessThanOrEqual(2)
    const send = () =>
      app.fetch(
        new Request("http://test/pay", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "k4",
            authorization: "Bearer good",
          },
          body: JSON.stringify({ amount: 7 }),
        }),
      )
    expect(await (await send()).json()).toEqual({ amount: 7 })
    expect((await send()).headers.get("x-nifra-idempotent-replay")).toBe("1")
  })

  test("a hook on an auth-first route reads the body under the route's cap", async () => {
    const app = server()
      .use(idempotency())
      .beforeHandle(async (c) => new Response(String((await c.req.text()).length)))
      .post(
        "/pay",
        {
          bodyLimit: 64,
          validationOrder: "auth-before-validation",
          idempotency: { scope: "request", namespace: "public:pay" },
        },
        () => "charged",
      )
    const response = await app.fetch(
      new Request("http://test/pay", {
        method: "POST",
        headers: { "idempotency-key": "k5" },
        body: "x".repeat(1_000),
      }),
    )
    expect(response.status).toBe(413)
  })

  test("a request the gate cannot prepare reaches the route error boundary", async () => {
    let caught: unknown
    const app = server()
      .use(idempotency())
      .onError((error) => {
        caught = error
        return new Response(null, { status: 500 })
      })
      .post("/pay", { idempotency: { scope: "request", namespace: "public:pay" } }, () => "charged")
    const request = new Request("http://test/pay", {
      method: "POST",
      headers: { "idempotency-key": "k6" },
      body: "{}",
    })
    // An exceptional request source, modeled without replacing the global Request constructor.
    Object.defineProperty(request, "signal", { value: {} })
    expect((await app.fetch(request)).status).toBe(500)
    expect(caught).toBeInstanceOf(TypeError)
    expect(String(caught)).toMatch(/signal is not of type AbortSignal/)
  })

  const hanging = new Promise<never>(() => {})
  const stalled: IdempotencyStore = Object.assign(new MemoryIdempotencyStore(), {
    begin: () => hanging,
  })
  for (const [name, route] of [
    ["namespace resolver", { namespace: () => hanging }],
    ["store", { namespace: "public:pay", store: stalled }],
  ] as const) {
    test(`a stalled ${name} answers at the request deadline`, async () => {
      const app = server({ requestTimeoutMs: 20 })
        .use(idempotency())
        .post("/pay", { idempotency: { scope: "request", ...route } }, () => "charged")
      const response = await app.fetch(
        new Request("http://test/pay", {
          method: "POST",
          headers: { "idempotency-key": "k3" },
          body: "{}",
        }),
      )
      expect(response.status).toBe(503)
    }, 2_000)
  }
})

describe("the gate fingerprints a codec-decoded payload, not its stand-in", () => {
  const rich = richWireCodec()
  const registry = createTransportCodecRegistry([plainJsonCodec, rich])
  const encoded = async (value: unknown) =>
    new Uint8Array(await encodeTransportResponse(value, rich).arrayBuffer())
  const send = async (
    app: { fetch(request: Request): Response | Promise<Response> },
    value: unknown,
  ) =>
    app.fetch(
      new Request("http://test/pay", {
        method: "POST",
        headers: { "content-type": rich.mediaType, "idempotency-key": "same" },
        body: await encoded(value),
      }),
    )

  test("a schema route receives the decoded body", async () => {
    const app = server()
      .use(transportCodecs(registry))
      .use(idempotency())
      .post(
        "/pay",
        {
          body: t.object({ amount: t.number() }),
          idempotency: { scope: "request", namespace: "public:pay" },
        },
        (c) => ({ got: c.body.amount }),
      )
    const response = await send(app, { amount: 10 })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ got: 10 })
  })

  test("a different payload under the same key is a mismatch, not a replay", async () => {
    const app = server()
      .use(transportCodecs(registry))
      .use(idempotency())
      .post(
        "/pay",
        {
          body: t.object({ amount: t.number() }),
          idempotency: { scope: "request", namespace: "public:pay" },
        },
        (c) => ({ got: c.body.amount }),
      )
    expect(await (await send(app, { amount: 10 })).json()).toEqual({ got: 10 })
    expect((await send(app, { amount: 10 })).headers.get("x-nifra-idempotent-replay")).toBe("1")
    expect((await send(app, { amount: 900 })).status).toBe(409)
  })
})
