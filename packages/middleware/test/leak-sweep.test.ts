import { describe, expect, spyOn, test } from "bun:test"
import { server } from "@nifrajs/core"
import { heapGrowth } from "@nifrajs/test-utils/leak"
import {
  bodyLimit,
  compression,
  cors,
  etag,
  idempotency,
  MemoryIdempotencyStore,
  MemoryStore,
  rateLimit,
  requestId,
  securityHeaders,
  timing,
} from "../src/index.ts"

/**
 * Hostile-traffic sweep: each stateful middleware is driven with an input that is new on every
 * request - a fresh client key, idempotency key, path, query key, origin, request id - far past the
 * bound of its own store. A store that keeps one entry per distinct input grows without limit and
 * shows here; one that is bounded reads flat.
 */

const CAP_BYTES_PER_ITERATION = 96

async function drain(response: Response): Promise<void> {
  await response.arrayBuffer()
}

describe("middleware retention under ever-new input", () => {
  test("rateLimit keyed by a new client every request", async () => {
    const app = server()
      .use(
        rateLimit({
          store: new MemoryStore({ maxKeys: 64 }),
          max: 5,
          windowMs: 60_000,
          key: (req) => req.headers.get("x-client") ?? "none",
        }),
      )
      .get("/", () => "ok")
    const result = await heapGrowth(async (i) => {
      await drain(await app.fetch(new Request("http://x/", { headers: { "x-client": `c${i}` } })))
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })

  test("idempotency keyed by a new Idempotency-Key every request", async () => {
    const app = server()
      .use(idempotency({ store: new MemoryIdempotencyStore({ maxEntries: 64 }) }))
      .post("/pay", () => "paid")
    const result = await heapGrowth(async (i) => {
      const response = await app.fetch(
        new Request("http://x/pay", {
          method: "POST",
          headers: { "idempotency-key": `key-${i}`, "content-type": "application/json" },
          body: JSON.stringify({ i }),
        }),
      )
      await drain(response)
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })

  test("the response stack on a new path, origin, request id and query key every request", async () => {
    const app = server()
      .use(requestId())
      .use(securityHeaders())
      .use(cors({ origin: "*" }))
      .use(etag())
      .use(compression())
      .use(timing())
      .use(bodyLimit({ maxBytes: 1024 }))
      .get("/item/:id", () => "x".repeat(2048))
    const result = await heapGrowth(async (i) => {
      const response = await app.fetch(
        new Request(`http://x/item/${i}?q${i}=1`, {
          headers: {
            origin: `https://o${i}.example`,
            "x-request-id": `rid-${i}`,
            "accept-encoding": "gzip",
            cookie: `c${i}=v${i}`,
          },
        }),
      )
      await drain(response)
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })

  test("404s on a new path and query key every request", async () => {
    const app = server()
      .use(requestId())
      .get("/", () => "ok")
    const result = await heapGrowth(async (i) => {
      await drain(
        await app.fetch(new Request(`http://x/missing/${i}/${"a".repeat(i % 50)}?k${i}=1`)),
      )
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })

  test("a handler that throws, on a new path every request", async () => {
    const app = server().get("/boom/:id", () => {
      throw new Error("boom")
    })
    const quiet = spyOn(console, "error").mockImplementation(() => undefined)
    const result = await heapGrowth(async (i) => {
      await drain(await app.fetch(new Request(`http://x/boom/${i}`)))
    })
    quiet.mockRestore()
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })

  test("requests aborted before and during the handler", async () => {
    const app = server()
      .use(requestId())
      .post("/echo", () => "ok")
    const result = await heapGrowth(async (i) => {
      const controller = new AbortController()
      const pending = app.fetch(
        new Request("http://x/echo", {
          method: "POST",
          body: JSON.stringify({ i }),
          headers: { "content-type": "application/json" },
          signal: controller.signal,
        }),
      )
      if (i % 2 === 0) controller.abort()
      try {
        await drain(await pending)
      } catch {
        // An aborted request may reject; only what it leaves behind is measured.
      }
    })
    expect(result.bytesPerIteration).toBeLessThan(CAP_BYTES_PER_ITERATION)
  })
})
