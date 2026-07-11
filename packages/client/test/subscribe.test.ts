import { describe, expect, test } from "bun:test"
import { server, sse } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import { testClient } from "../src/index.ts"

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
    const app = server().sse("/feed", { sse: post }, (_c, stream) => {
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
    const app = server().sse("/one", { sse: post }, (_c, stream) => {
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
    const app = server().sse("/tap", { sse: post }, (_c, stream) => {
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
    const app = server().sse("/sig", { sse: post }, (_c, stream) => {
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
})
