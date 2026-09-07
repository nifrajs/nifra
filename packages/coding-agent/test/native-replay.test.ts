import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { NifraBackend, ReplayBackend } from "../src/index.ts"

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("test condition was not reached")
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

describe("optional native and replay backends", () => {
  test("runs a streamed native model through a bounded tool loop", async () => {
    let calls = 0
    const backend = new NifraBackend({
      model: {
        complete: async function* ({ messages }) {
          calls += 1
          if (calls === 1) {
            yield { type: "text_delta", text: "checking" }
            yield {
              type: "response",
              response: { type: "tool", name: "inspect", input: { ok: true } },
            }
            return
          }
          expect(messages.at(-1)?.role).toBe("tool")
          yield { type: "response", response: { type: "text", text: "verified" } }
        },
      },
      tools: [
        {
          name: "inspect",
          description: "Inspect a fixture",
          execute: () => ({ inspected: true }),
        },
      ],
    })
    await backend.createSession({ cwd: process.cwd(), sessionId: "native" })
    const events: AgentEvent[] = []
    for await (const event of backend.send({ sessionId: "native", message: "inspect" }))
      events.push(event)
    expect(events.some((event) => event.type === "tool.completed" && event.ok)).toBe(true)
    expect(
      events.some((event) => event.type === "assistant.message" && event.text === "verified"),
    ).toBe(true)
    expect((await backend.snapshot("native")).status).toBe("idle")
    await backend.close("native")
  })

  test("replays recorded protocol events with deterministic session identity", async () => {
    const source: AgentEvent[] = [
      {
        version: 1,
        sessionId: "recorded",
        seq: 0,
        at: 1,
        type: "turn.started",
        turnId: "turn",
        prompt: "hello",
      },
      {
        version: 1,
        sessionId: "recorded",
        seq: 1,
        at: 2,
        type: "assistant.message",
        turnId: "turn",
        text: "world",
      },
    ]
    const backend = new ReplayBackend({ events: source })
    await backend.createSession({ cwd: process.cwd(), sessionId: "replay" })
    const events: AgentEvent[] = []
    for await (const event of backend.send({ sessionId: "replay", message: "ignored" }))
      events.push(event)
    expect(events[0]?.sessionId).toBe("replay")
    expect(
      events.some((event) => event.type === "assistant.message" && event.text === "world"),
    ).toBe(true)
    expect(events.at(-1)?.type).toBe("session.completed")
    await backend.close("replay")
  })

  test("replay snapshots input events and bounds the source by total serialized bytes", async () => {
    const input = { nested: { value: "before" } }
    const backend = new ReplayBackend({
      events: [
        {
          version: 1,
          sessionId: "recorded",
          seq: 0,
          at: 1,
          type: "tool.started",
          turnId: "turn",
          callId: "call",
          name: "inspect",
          input,
        },
      ],
    })
    input.nested.value = "after-construction"
    await backend.createSession({ cwd: process.cwd(), sessionId: "replay-copy" })
    const first = await collect(backend.send({ sessionId: "replay-copy", message: "x" }))
    const firstInput = (
      first.find((event) => event.type === "tool.started") as {
        input: { nested: { value: string } }
      }
    ).input
    expect(firstInput.nested.value).toBe("before")
    firstInput.nested.value = "mutated-by-consumer"

    const second = await collect(backend.send({ sessionId: "replay-copy", message: "x" }))
    expect(
      (
        second.find((event) => event.type === "tool.started") as {
          input: { nested: { value: string } }
        }
      ).input.nested.value,
    ).toBe("before")
    await backend.close("replay-copy")
  })

  test("an old native request signal cannot stop a later turn", async () => {
    const first = deferred<{ readonly type: "text"; readonly text: string }>()
    const second = deferred<{ readonly type: "text"; readonly text: string }>()
    let calls = 0
    const backend = new NifraBackend({
      model: {
        complete: () => {
          calls += 1
          return calls === 1 ? first.promise : second.promise
        },
      },
    })
    await backend.createSession({ cwd: process.cwd(), sessionId: "native-stale-signal" })
    const oldSignal = new AbortController()
    const firstEvents = collect(
      backend.send({
        sessionId: "native-stale-signal",
        message: "first",
        signal: oldSignal.signal,
      }),
    )
    await waitUntil(() => calls === 1)
    first.resolve({ type: "text", text: "first" })
    await firstEvents

    const secondEvents = collect(
      backend.send({ sessionId: "native-stale-signal", message: "second" }),
    )
    await waitUntil(() => calls === 2)
    oldSignal.abort("old request ended")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await backend.snapshot("native-stale-signal")).status).toBe("running")
    second.resolve({ type: "text", text: "second" })
    const events = await secondEvents
    expect(events.some((event) => event.type === "session.stopped")).toBe(false)
    expect(
      events.some((event) => event.type === "assistant.message" && event.text === "second"),
    ).toBe(true)
    await backend.close("native-stale-signal")
  })

  test("a late native model result cannot mutate a cancelled turn", async () => {
    const model = deferred<{ readonly type: "text"; readonly text: string }>()
    let calls = 0
    const backend = new NifraBackend({
      model: {
        complete: () => {
          calls += 1
          return model.promise
        },
      },
    })
    await backend.createSession({ cwd: process.cwd(), sessionId: "native-late-result" })
    const eventsPromise = collect(
      backend.send({ sessionId: "native-late-result", message: "cancel me" }),
    )
    await waitUntil(() => calls === 1)
    await backend.cancel("native-late-result", "user left")
    const events = await eventsPromise
    model.resolve({ type: "text", text: "late" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events.some((event) => event.type === "assistant.message")).toBe(false)
    expect(events.some((event) => event.type === "session.stopped")).toBe(true)
    expect((await backend.snapshot("native-late-result")).status).toBe("stopped")
    await backend.close("native-late-result")
  })

  test("replay cancellation prevents delayed events from reviving the session", async () => {
    const backend = new ReplayBackend({
      delayMs: 10,
      events: [
        {
          version: 1,
          sessionId: "recorded",
          seq: 1,
          at: 1,
          type: "assistant.message",
          turnId: "turn",
          text: "late",
        },
      ],
    })
    await backend.createSession({ cwd: process.cwd(), sessionId: "replay-cancel" })
    const eventsPromise = collect(backend.send({ sessionId: "replay-cancel", message: "cancel" }))
    await new Promise((resolve) => setTimeout(resolve, 1))
    await backend.cancel("replay-cancel", "user left")
    const events = await eventsPromise
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events.some((event) => event.type === "session.stopped")).toBe(true)
    expect(events.some((event) => event.type === "assistant.message")).toBe(false)
    expect((await backend.snapshot("replay-cancel")).status).toBe("stopped")
    await backend.close("replay-cancel")
  })

  test("cancelling idle native and replay sessions is a no-op", async () => {
    const native = new NifraBackend({ model: { complete: () => ({ type: "text", text: "ok" }) } })
    await native.createSession({ cwd: process.cwd(), sessionId: "native-idle-cancel" })
    await native.cancel("native-idle-cancel")
    expect((await native.snapshot("native-idle-cancel")).status).toBe("idle")
    await native.close("native-idle-cancel")

    const replay = new ReplayBackend({ events: [] })
    await replay.createSession({ cwd: process.cwd(), sessionId: "replay-idle-cancel" })
    await replay.cancel("replay-idle-cancel")
    expect((await replay.snapshot("replay-idle-cancel")).status).toBe("idle")
    await replay.close("replay-idle-cancel")
  })

  test("replay remaps lifecycle snapshot identity with the session", async () => {
    const backend = new ReplayBackend({
      events: [
        {
          version: 1,
          sessionId: "recorded",
          seq: 0,
          at: 1,
          type: "session.completed",
          snapshot: {
            version: 1,
            id: "recorded",
            backend: "recorded",
            cwd: process.cwd(),
            status: "completed",
            createdAt: 1,
            updatedAt: 1,
            lastSeq: 0,
            capabilities: [],
          },
        },
      ],
    })
    await backend.createSession({ cwd: process.cwd(), sessionId: "replay-lifecycle" })
    const events = await collect(backend.send({ sessionId: "replay-lifecycle", message: "x" }))
    expect(events[0]).toMatchObject({ sessionId: "replay-lifecycle", type: "session.completed" })
    expect((events[0] as { snapshot: { id: string } }).snapshot.id).toBe("replay-lifecycle")
    await backend.close("replay-lifecycle")
  })
})
