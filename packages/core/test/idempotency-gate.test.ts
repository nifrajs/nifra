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
function endlessPost(url: string, headers: Record<string, string>) {
  let chunks = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks++
      controller.enqueue(new TextEncoder().encode(" "))
    },
  })
  const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body, duplex: "half" }
  const request = new Request(url, init)
  return { request, chunks: () => chunks }
}

describe("the idempotency gate runs inside the route program", () => {
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
