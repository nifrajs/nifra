import { describe, expect, test } from "bun:test"
import type {
  AgentBackend,
  AgentEvent,
  AgentEventPayload,
  AgentSessionSnapshot,
  CreateSessionInput,
  SendMessageInput,
} from "@nifrajs/agent-protocol"
import { CodingAgentRpcServer, type CodingAgentRpcServerOptions } from "../src/rpc.ts"
import { ReplayableTurn } from "../src/turn-replay.ts"

/** Emits one assistant.delta per released gate, then completes the turn. */
class GatedBackend implements AgentBackend {
  readonly info = { name: "gated", capabilities: [] }
  readonly cancels: string[] = []
  readonly cancelled = Promise.withResolvers<void>()
  /** How many deltas the backend has produced so far. */
  produced = 0
  private readonly gates: Array<PromiseWithResolvers<void>> = []
  private current: AgentSessionSnapshot | undefined
  private seq = 0

  constructor(
    private readonly steps: number,
    private readonly delta: (step: number) => string = (step) => `step-${step}`,
  ) {
    for (let index = 0; index < steps; index++) this.gates.push(Promise.withResolvers<void>())
  }

  release(step: number): void {
    this.gates[step]?.resolve()
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    const now = Date.now()
    this.current = {
      version: 1,
      id: input.sessionId ?? "gated-session",
      backend: this.info.name,
      cwd: input.cwd,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      capabilities: [],
    }
    return this.current
  }

  send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    const backend = this
    return (async function* (): AsyncGenerator<AgentEvent> {
      yield backend.event({ type: "turn.started", turnId: "t1", prompt: input.message })
      for (let step = 0; step < backend.steps; step++) {
        await Promise.race([backend.gates[step]?.promise, backend.cancelled.promise])
        if (backend.cancels.length > 0) {
          yield backend.event({ type: "session.stopped", reason: "cancelled" })
          return
        }
        backend.produced++
        yield backend.event({ type: "assistant.delta", turnId: "t1", text: backend.delta(step) })
      }
      yield backend.event({ type: "assistant.message", turnId: "t1", text: "done" })
    })()
  }

  async cancel(_sessionId: string, reason = "cancelled"): Promise<void> {
    this.cancels.push(reason)
    this.cancelled.resolve()
  }

  async snapshot(): Promise<AgentSessionSnapshot> {
    if (this.current === undefined) throw new Error("gated backend: no session")
    return this.current
  }

  async reload() {
    return { revision: "1", loaded: [], disabled: [], rolledBack: false }
  }

  async close(): Promise<void> {}

  private event(payload: AgentEventPayload): AgentEvent {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: one payload member under the envelope is its own AgentEvent member; TS cannot distribute the spread.
    return {
      version: 1,
      sessionId: this.current?.id ?? "gated-session",
      seq: this.seq++,
      at: Date.now(),
      ...payload,
    } as AgentEvent
  }
}

interface Frame {
  readonly id: string | undefined
  readonly event: string | undefined
  readonly data: string
}

class FrameReader {
  private buffer = ""
  private readonly decoder = new TextDecoder()

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async next(): Promise<Frame | undefined> {
    for (;;) {
      const boundary = this.buffer.indexOf("\n\n")
      if (boundary !== -1) {
        const raw = this.buffer.slice(0, boundary)
        this.buffer = this.buffer.slice(boundary + 2)
        const fields = new Map(
          raw
            .split("\n")
            .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
        )
        return { id: fields.get("id"), event: fields.get("event"), data: fields.get("data") ?? "" }
      }
      const { done, value } = await this.reader.read()
      if (done) return undefined
      this.buffer += this.decoder.decode(value, { stream: true })
    }
  }

  async rest(): Promise<Frame[]> {
    const frames: Frame[] = []
    for (let frame = await this.next(); frame !== undefined; frame = await this.next())
      frames.push(frame)
    return frames
  }

  cancel(): Promise<void> {
    return this.reader.cancel()
  }
}

async function serve(
  backend: AgentBackend,
  options: Partial<CodingAgentRpcServerOptions> = {},
): Promise<{
  readonly call: (
    method: string,
    params?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>
  readonly stop: () => Promise<void>
}> {
  const handle = await new CodingAgentRpcServer({ cwd: process.cwd(), backend, ...options }).start()
  const call = (method: string, params?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${handle.url}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${handle.token}`,
        "content-type": "application/json",
        ...headers,
      },
      // JSON leaves out an undefined params.
      body: JSON.stringify({ method, params }),
    })
  expect((await call("session.create")).status).toBe(200)
  return { call, stop: handle.stop }
}

function frames(response: Response): FrameReader {
  if (response.body === null) throw new Error("response has no body")
  return new FrameReader(response.body.getReader())
}

function text(frame: Frame | undefined): string | undefined {
  const value: unknown = frame === undefined ? undefined : JSON.parse(frame.data)
  return typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof value.text === "string"
    ? value.text
    : undefined
}

describe("resumable RPC turns", () => {
  test("a client that drops reads what it missed and follows the rest", async () => {
    const backend = new GatedBackend(3)
    const server = await serve(backend, { resumableTurns: true })
    try {
      const first = frames(await server.call("turn.send", { message: "go" }))
      const started = await first.next()
      backend.release(0)
      const step0 = await first.next()
      expect(started?.id).toBeDefined()
      expect(text(step0)).toBe("step-0")
      await first.cancel()

      backend.release(1)
      const resumed = frames(await server.call("turn.attach", { afterSeq: Number(step0?.id) }))
      expect(text(await resumed.next())).toBe("step-1")
      backend.release(2)
      const rest = await resumed.rest()
      expect(rest.map(text)).toEqual(["step-2", "done"])
      expect(backend.cancels).toEqual([])

      // Once the turn has ended, Last-Event-ID replays from the cursor and closes.
      const replay = frames(
        await server.call("turn.attach", undefined, { "last-event-id": String(step0?.id) }),
      )
      expect((await replay.rest()).map(text)).toEqual(["step-1", "step-2", "done"])
      const whole = frames(await server.call("turn.attach"))
      // turn.started carries the prompt, not text.
      expect((await whole.rest()).map(text)).toEqual([
        undefined,
        "step-0",
        "step-1",
        "step-2",
        "done",
      ])
    } finally {
      await server.stop()
    }
  })

  test("a turn no client follows is cancelled after the detached timeout", async () => {
    const backend = new GatedBackend(1)
    const server = await serve(backend, { resumableTurns: { detachedTimeoutMs: 1 } })
    try {
      const first = frames(await server.call("turn.send", { message: "go" }))
      await first.next()
      await first.cancel()
      await backend.cancelled.promise
      expect(backend.cancels).toEqual(["no client followed the turn"])
    } finally {
      await server.stop()
    }
  })

  test("refuses a second turn, a stale cursor, and a bad one", async () => {
    const backend = new GatedBackend(4)
    const server = await serve(backend, { resumableTurns: { replayEvents: 2 } })
    try {
      const first = frames(await server.call("turn.send", { message: "go" }))
      const started = await first.next()
      const busy = await server.call("turn.send", { message: "again" })
      expect(busy.status).toBe(409)
      expect(await busy.json()).toMatchObject({ error: { code: "turn_running" } })

      for (let step = 0; step < 4; step++) backend.release(step)
      await first.rest()
      const stale = await server.call("turn.attach", { afterSeq: Number(started?.id) })
      expect(stale.status).toBe(409)
      expect(await stale.json()).toMatchObject({ error: { code: "resync_required" } })
      const future = await server.call("turn.attach", { afterSeq: 10_000 })
      expect(future.status).toBe(409)
      const bad = await server.call("turn.attach", { afterSeq: "x" })
      expect(bad.status).toBe(422)
    } finally {
      await server.stop()
    }
  })

  test("a client that stops reading holds the turn still instead of the server queueing it", async () => {
    const steps = 256
    const backend = new GatedBackend(steps, () => "x".repeat(64 * 1024))
    for (let step = 0; step < steps; step++) backend.release(step)
    const server = await serve(backend)
    try {
      const unread = await server.call("turn.send", { message: "go" })
      // Let the socket fill: production stops once nothing more is pulled.
      let last = -1
      for (let quiet = 0; quiet < 50; ) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        quiet = backend.produced === last ? quiet + 1 : 0
        last = backend.produced
      }
      expect(backend.produced).toBeLessThan(steps)
      await unread.body?.cancel()
      await backend.cancelled.promise
      expect(backend.cancels).toEqual(["client disconnected"])
    } finally {
      await server.stop()
    }
  })

  test("control: a client that reads receives the whole turn", async () => {
    const steps = 256
    const backend = new GatedBackend(steps, () => "x".repeat(64 * 1024))
    for (let step = 0; step < steps; step++) backend.release(step)
    const server = await serve(backend)
    try {
      const read = await frames(await server.call("turn.send", { message: "go" })).rest()
      expect(read.filter((frame) => text(frame)?.length === 64 * 1024)).toHaveLength(steps)
      expect(backend.produced).toBe(steps)
    } finally {
      await server.stop()
    }
  })

  test("without resumableTurns a disconnect still cancels and attach is unsupported", async () => {
    const backend = new GatedBackend(1)
    const server = await serve(backend)
    try {
      const attach = await server.call("turn.attach")
      expect(attach.status).toBe(501)
      expect(await attach.json()).toMatchObject({ error: { code: "feature_unsupported" } })
      const first = frames(await server.call("turn.send", { message: "go" }))
      expect((await first.next())?.id).toBeDefined()
      await first.cancel()
      await backend.cancelled.promise
      expect(backend.cancels).toEqual(["client disconnected"])
    } finally {
      await server.stop()
    }
  })
})

describe("ReplayableTurn", () => {
  const bytes = (value: string) => new TextEncoder().encode(value)
  const read = async (stream: ReadableStream<Uint8Array> | undefined) =>
    stream === undefined ? undefined : await new Response(stream).text()

  test("keeps the newest frames within its limits and refuses cursors it cannot serve", async () => {
    const turn = new ReplayableTurn(9, { maxEvents: 3, maxBytes: 1024 }, () => {})
    for (let seq = 10; seq < 15; seq++) turn.push(seq, bytes(`${seq};`))
    turn.end(bytes("end;"))
    expect(await read(turn.attach(11))).toBe("12;13;14;end;")
    expect(await read(turn.attach(14))).toBe("end;")
    expect(turn.attach(10)).toBeUndefined()
    expect(turn.attach()).toBeUndefined()
    expect(turn.attach(15)).toBeUndefined()
  })

  test("a byte limit keeps at least the newest frame", async () => {
    const turn = new ReplayableTurn(-1, { maxEvents: 10, maxBytes: 4 }, () => {})
    turn.push(0, bytes("aaaa"))
    turn.push(1, bytes("bbbbbbbb"))
    turn.end()
    expect(await read(turn.attach(0))).toBe("bbbbbbbb")
    expect(turn.attach(-1)).toBeUndefined()
  })

  test("a follower that stops reading is dropped past the budget and can attach again", async () => {
    const counts: number[] = []
    const turn = new ReplayableTurn(-1, { maxEvents: 1024, maxBytes: 1024 }, (count) =>
      counts.push(count),
    )
    const unread = turn.follow()
    for (let seq = 0; seq < 100; seq++) turn.push(seq, bytes("x".repeat(100)))
    expect(turn.following).toBe(0)
    expect(counts).toEqual([1, 0])
    await expect(unread.getReader().read()).rejects.toThrow("turn follower fell behind")
    const again = turn.attach(95)
    turn.end()
    expect(await read(again)).toBe("x".repeat(400))
  })

  test("reports how many clients follow while it runs", async () => {
    const counts: number[] = []
    const turn = new ReplayableTurn(-1, { maxEvents: 10, maxBytes: 1024 }, (count) =>
      counts.push(count),
    )
    const one = turn.follow()
    const two = turn.follow()
    await one.cancel()
    turn.push(0, bytes("x"))
    turn.end()
    expect(await read(two)).toBe("x")
    expect(counts).toEqual([1, 2, 1])
  })
})
