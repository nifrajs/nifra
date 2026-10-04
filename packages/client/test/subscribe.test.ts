import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { sse, streaming } from "@nifrajs/core/sse"
import { t } from "@nifrajs/schema"
import { type ClientOptions, client, type FetchFn, testClient } from "../src/index.ts"

const post = t.object({ id: t.integer(), title: t.string() })

function collect<T>(count: number): {
  events: T[]
  push: (event: T) => void
  done: Promise<void>
} {
  const events: T[] = []
  let resolve!: () => void
  const done = new Promise<void>((r) => {
    resolve = r
  })
  return {
    events,
    push: (event) => {
      events.push(event)
      if (events.length >= count) resolve()
    },
    done,
  }
}

describe("api.route.subscribe()", () => {
  test("receives typed events from an app.sse route (finite stream, reconnect: false)", async () => {
    const app = server()
      .use(streaming())
      .sse("/feed", { sse: post }, (_c, stream) => {
        stream.send({ id: 1, title: "hello" })
        stream.send({ id: 2, title: "world" })
        stream.close()
      })
    const api = testClient<typeof app>(app)

    const { events, push, done } = collect<{ id: number; title: string }>(2)
    const subscription = api.feed.subscribe((event) => push(event), { reconnect: false })
    await done
    subscription.close()

    expect(events).toEqual([
      { id: 1, title: "hello" },
      { id: 2, title: "world" },
    ])
    // Type-level: `event` is the sse schema's shape.
    const title: string = events[0]!.title
    expect(title).toBe("hello")
  })

  test("clean end with reconnect: false calls onClose exactly once", async () => {
    const app = server()
      .use(streaming())
      .sse("/one", { sse: post }, (_c, stream) => {
        stream.send({ id: 1, title: "only" })
        stream.close()
      })
    const api = testClient<typeof app>(app)
    let closes = 0
    const { push, done } = collect<unknown>(1)
    api.one.subscribe((e) => push(e), { reconnect: false, onClose: () => closes++ })
    await done
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(closes).toBe(1)
  })

  test("reconnects after a dropped stream and resumes via Last-Event-ID", async () => {
    let connections = 0
    const seenLastEventIds: Array<string | null> = []
    const app = server().get("/resume", (c) =>
      sse(c, (stream) => {
        connections++
        seenLastEventIds.push(c.req.headers.get("last-event-id"))
        if (connections === 1) {
          stream.send({ id: "1", data: JSON.stringify({ id: 1, title: "first" }) })
          stream.close() // drop → client should reconnect
        } else {
          stream.send({ id: "2", data: JSON.stringify({ id: 2, title: "second" }) })
          stream.close()
        }
      }),
    )
    const api = testClient<typeof app>(app)

    const { events, push, done } = collect<{ id: number }>(2)
    // Untyped route → cast the proxy node; runtime path is identical to a typed app.sse route.
    const node = (api as unknown as Record<string, unknown>).resume as unknown as {
      subscribe: (
        onEvent: (e: { id: number }) => void,
        options?: { reconnect?: { baseDelayMs: number } },
      ) => { close(): void }
    }
    const subscription = node.subscribe((e) => push(e), { reconnect: { baseDelayMs: 5 } })
    await done
    subscription.close()

    expect(connections).toBeGreaterThanOrEqual(2)
    expect(seenLastEventIds[0]).toBeNull()
    expect(seenLastEventIds[1]).toBe("1") // resumed from the last seen id
    expect(events.map((e) => e.id)).toEqual([1, 2])
  })

  test("close() stops reconnection; no events after close", async () => {
    let connections = 0
    const app = server()
      .use(streaming())
      .sse("/tap", { sse: post }, (_c, stream) => {
        connections++
        stream.send({ id: connections, title: "tick" })
        stream.close()
      })
    const api = testClient<typeof app>(app)
    const { events, push, done } = collect<{ id: number }>(1)
    const subscription = api.tap.subscribe((e) => push(e), {
      reconnect: { baseDelayMs: 5 },
    })
    await done
    subscription.close()
    const seen = events.length
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(events.length).toBe(seen)
  })

  test("non-2xx responses surface through onError (and stop with reconnect: false)", async () => {
    const app = server().get("/nope", (c) => {
      c.set.status = 503
      return { error: "down" }
    })
    const api = testClient<typeof app>(app)
    const errors: unknown[] = []
    let closed = false
    const node = (api as unknown as Record<string, unknown>).nope as unknown as {
      subscribe: (
        onEvent: (e: unknown) => void,
        options?: {
          reconnect?: boolean
          onError?: (e: unknown) => void
          onClose?: () => void
        },
      ) => { close(): void }
    }
    node.subscribe(() => {}, {
      reconnect: false,
      onError: (e) => errors.push(e),
      onClose: () => {
        closed = true
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(errors.length).toBe(1)
    expect(String(errors[0])).toContain("sse_http_503")
    expect(closed).toBe(true)
  })

  test("bad JSON in a frame reaches onError; the stream continues", async () => {
    const app = server().get("/mixed", (c) =>
      sse(c, (stream) => {
        stream.send({ data: "not-json" })
        stream.send({ data: JSON.stringify({ id: 9, title: "fine" }) })
        stream.close()
      }),
    )
    const api = testClient<typeof app>(app)
    const errors: unknown[] = []
    const { events, push, done } = collect<{ id: number }>(1)
    const node = (api as unknown as Record<string, unknown>).mixed as unknown as {
      subscribe: (
        onEvent: (e: { id: number }) => void,
        options?: { reconnect?: boolean; onError?: (e: unknown) => void },
      ) => { close(): void }
    }
    node.subscribe((e) => push(e), { reconnect: false, onError: (e) => errors.push(e) })
    await done
    expect(errors.length).toBe(1)
    expect(events[0]?.id).toBe(9)
  })

  test("an aborted options.signal closes the subscription", async () => {
    const app = server()
      .use(streaming())
      .sse("/sig", { sse: post }, (_c, stream) => {
        stream.send({ id: 1, title: "x" })
        stream.close()
      })
    const api = testClient<typeof app>(app)
    const controller = new AbortController()
    let closed = false
    const { push, done } = collect<unknown>(1)
    api.sig.subscribe((e) => push(e), {
      signal: controller.signal,
      reconnect: { baseDelayMs: 5 },
      onClose: () => {
        closed = true
      },
    })
    await done
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(closed).toBe(true)
  })
  test("parses the id and retry frame fields alongside the data payload", async () => {
    // `retry:` re-times the client's own reconnect and `id:` seeds Last-Event-ID, so both are read
    // off the wire even though neither reaches the event callback.
    const app = server()
      .use(streaming())
      .sse("/timed", { sse: post }, (_c, stream) => {
        stream.send({ id: 1, title: "hello" }, { id: "evt-1", retry: 250 })
        stream.close()
      })
    const api = testClient<typeof app>(app)

    const { events, push, done } = collect<{ id: number; title: string }>(1)
    const subscription = api.timed.subscribe((event) => push(event), { reconnect: false })
    await done
    subscription.close()

    expect(events).toEqual([{ id: 1, title: "hello" }])
  })

  test("ignores a malformed retry value rather than breaking the stream", async () => {
    const app = server()
      .use(streaming())
      .sse("/bad-retry", { sse: post }, (_c, stream) => {
        stream.send({ id: 1, title: "hello" }, { retry: Number.NaN })
        stream.send({ id: 2, title: "world" })
        stream.close()
      })
    const api = testClient<typeof app>(app)

    const { events, push, done } = collect<{ id: number; title: string }>(2)
    const subscription = api["bad-retry"].subscribe((event) => push(event), { reconnect: false })
    await done
    subscription.close()

    expect(events).toEqual([
      { id: 1, title: "hello" },
      { id: 2, title: "world" },
    ])
  })
})

const feedApp = server()
  .use(streaming())
  .sse("/events", { sse: t.union([t.number(), t.object({ a: t.number() })]) }, (_c, stream) =>
    stream.close(),
  )

/** `.subscribe()` on a route served by `fetch` alone, so a test controls every byte and reconnect. */
function eventsOver(fetch: FetchFn, options: Omit<ClientOptions, "fetch"> = {}) {
  return client<typeof feedApp>("http://t", { ...options, fetch }).events.subscribe
}

function eventStream(...chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe("subscribe() reconnect and framing", () => {
  test("a retry hint times the reconnect after a served stream, never a failing one", async () => {
    let connects = 0
    const subscription = eventsOver(async () => {
      connects += 1
      return connects === 1 ? eventStream("retry: 0\n\n") : new Response("down", { status: 503 })
    })(() => {}, { reconnect: { baseDelayMs: 40 }, onError: () => {} })
    await sleep(300)
    subscription.close()
    // Straight back after the served stream, then 40-80ms, 80-160ms, ... while the server answers 503.
    expect(connects).toBeGreaterThanOrEqual(3)
    expect(connects).toBeLessThanOrEqual(5)
  })

  test("a retry value that is not plain digits is ignored", async () => {
    for (const value of ["", "-1", "+0", "0.5"]) {
      let connects = 0
      const subscription = eventsOver(async () => {
        connects += 1
        return eventStream(`retry: ${value}\ndata: 1\n\n`)
      })(() => {}, { reconnect: { baseDelayMs: 400 } })
      await sleep(100)
      subscription.close()
      expect({ value, connects }).toEqual({ value, connects: 1 })
    }
  })

  test("CR, LF, and CRLF all end a line, including a CRLF split across reads", async () => {
    const events: unknown[] = []
    const errors: unknown[] = []
    await new Promise<void>((resolve) => {
      eventsOver(async () =>
        eventStream('data: {"a":\r', "\ndata: 1}\r\n\r\n", "data: 2\r\rdata: 3\r", "\r"),
      )((event) => events.push(event), {
        reconnect: false,
        onError: (error) => errors.push(error),
        onClose: resolve,
      })
    })
    expect(errors).toEqual([])
    expect(events).toEqual([{ a: 1 }, 2, 3])
  })

  test("an event that outgrows maxDecodedBytes fails the stream and cancels it", async () => {
    let cancelled = false
    const errors: unknown[] = []
    const endless = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(1024)}`))
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    await new Promise<void>((resolve) => {
      eventsOver(async () => endless(), { maxDecodedBytes: 64 * 1024 })(() => {}, {
        reconnect: false,
        onError: (error) => errors.push(error),
        onClose: resolve,
      })
    })
    await sleep(10)
    expect(String(errors[0])).toContain("sse_event_too_large")
    expect(cancelled).toBe(true)
  })

  test("an id beyond Latin-1 resumes as its UTF-8 bytes, and an id with a NUL is ignored", async () => {
    const seen: (string | null)[] = []
    let connects = 0
    const subscription = eventsOver(async (_url, init) => {
      connects += 1
      seen.push(new Headers(init?.headers).get("last-event-id"))
      if (connects === 1) return eventStream("id: \u20ac1\ndata: 1\n\n")
      return eventStream("id: a\u0000b\ndata: 2\n\n")
    })(() => {}, { reconnect: { baseDelayMs: 1, maxDelayMs: 1 }, onError: () => {} })
    for (let waited = 0; seen.length < 3 && waited < 1_000; waited += 5) await sleep(5)
    subscription.close()
    expect(seen.slice(0, 3)).toEqual([null, "\u00e2\u0082\u00ac1", "\u00e2\u0082\u00ac1"])
  })
})

describe("bodies the client abandons", () => {
  /** A body that enqueues `chunks` and then refuses to be cancelled. */
  const refusingBody = (chunks: readonly string[], onCancel: () => void) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      },
      cancel() {
        onCancel()
        throw new Error("cancel failed")
      },
    })
  const app = server()
    .use(streaming())
    .get("/thing", () => ({ n: 1 }))
    .sse("/feed", { sse: post }, (_c, stream) => stream.close())

  test("a retried answer whose body refuses cancel does not stop the retry", async () => {
    let calls = 0
    let cancelled = false
    const fetch: FetchFn = async () => {
      calls += 1
      return calls === 1
        ? new Response(
            refusingBody([], () => (cancelled = true)),
            { status: 503 },
          )
        : Response.json({ n: 2 })
    }
    const api = client<typeof app>("http://t", { fetch, retry: { attempts: 2, backoff: () => 0 } })
    const res = await api.thing.get()
    await Bun.sleep(0)
    expect(res.ok).toBe(true)
    expect(calls).toBe(2)
    expect(cancelled).toBe(true)
  })

  test("a refused stream connect and an oversized event still report their errors", async () => {
    const cases = [
      {
        response: () =>
          new Response(
            refusingBody([], () => {}),
            { status: 503 },
          ),
        error: "sse_http_503",
      },
      {
        response: () =>
          new Response(
            refusingBody([`data: ${"x".repeat(200)}`], () => {}),
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
        error: "sse_event_too_large",
      },
    ]
    for (const { response, error } of cases) {
      const fetch: FetchFn = async () => response()
      const errors: unknown[] = []
      const closed = Promise.withResolvers<void>()
      client<typeof app>("http://t", { fetch, maxDecodedBytes: 64 }).feed.subscribe(() => {}, {
        reconnect: false,
        onError: (failure) => errors.push(failure),
        onClose: () => closed.resolve(),
      })
      await closed.promise
      await Bun.sleep(0)
      expect(String(errors[0])).toContain(error)
    }
  })
})
