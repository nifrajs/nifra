/**
 * A producer that pushes to a client (an event stream, a subscription queue) holds at most a declared
 * cap for a client that stops reading: it drops the client or ends the stream, never queues the whole
 * flood. Each member is flooded well past a small cap while nothing reads, then a late reader drains
 * it and must get no more than the cap plus one frame. A control with a cap above the flood requires
 * the flood to arrive whole, so a harness that never produced cannot pass. The registry at the end
 * fails when a new event-stream producer appears without being enrolled or named as not one.
 */
import { describe, expect, test } from "bun:test"
import { mountAgUI } from "@nifrajs/ag-ui"
import type { AgentDefinition } from "@nifrajs/agent"
import { mountAgent } from "@nifrajs/agent/mount"
import { server } from "@nifrajs/core"
import { sse } from "@nifrajs/core/sse"
import { devtools } from "@nifrajs/devtools"
import { createPubSub } from "@nifrajs/graphql"
import { defineMcpTool, respondMcpHttp } from "@nifrajs/mcp"
import { t } from "@nifrajs/schema"

/** Read until the stream ends, errors, or passes `ceiling` units; returns what was delivered. */
async function drain(body: ReadableStream<Uint8Array> | null, ceiling: number): Promise<number> {
  if (body === null) return 0
  const reader = body.getReader()
  let delivered = 0
  try {
    while (delivered <= ceiling) {
      const { done, value } = await reader.read()
      if (done) break
      delivered += value.byteLength
    }
  } catch {
    // A dropped client ends in an error; what arrived before it is what counts.
  }
  await reader.cancel().catch(() => {})
  return delivered
}

interface Producer {
  readonly name: string
  /** The source file that decides how much is queued for an unread client. */
  readonly file: string
  /** The unit the cap and the flood are counted in. */
  readonly unit: "bytes" | "events"
  /** The smallest cap the member accepts, used for the flood. */
  readonly cap: number
  /** Largest single frame, in units: the most a reader may receive past the cap. */
  readonly frame: number
  /** Floods `total` units while nothing reads, then returns what a late reader receives. */
  flood(cap: number, total: number): Promise<number>
}

const agent: AgentDefinition<
  ReturnType<typeof t.object<{ prompt: ReturnType<typeof t.string> }>>,
  ReturnType<typeof t.object<{ answer: ReturnType<typeof t.string> }>>
> = {
  name: "invariants-agent",
  instruction: "Answer.",
  input: t.object({ prompt: t.string() }),
  output: t.object({ answer: t.string() }),
  tools: [],
}

const CHUNK = "x".repeat(200)

const PRODUCERS: readonly Producer[] = [
  {
    name: "core sse()",
    file: "packages/core/src/server/sse.ts",
    unit: "bytes",
    cap: 4096,
    frame: 256,
    flood: async (cap, total) => {
      const app = server().get("/s", (c) =>
        sse(
          c,
          (stream) => {
            for (let sent = 0; sent < total && !stream.signal.aborted; sent += CHUNK.length + 8)
              stream.send({ data: CHUNK })
            return new Promise<void>(() => {})
          },
          { maxBufferedBytes: cap },
        ),
      )
      const res = await app.fetch(new Request("http://x/s"))
      return drain(res.body, total)
    },
  },
  {
    name: "mountAgUI",
    file: "packages/ag-ui/src/index.ts",
    unit: "bytes",
    cap: 1024,
    frame: 512,
    flood: async (cap, total) => {
      const app = server()
      mountAgUI(app, {
        agent,
        maxOutputBytes: cap,
        ports: () => ({
          capabilities: [],
          model: {
            complete: ({ onDelta }) => {
              for (let sent = 0; sent < total; sent += CHUNK.length)
                onDelta?.({ kind: "text", text: CHUNK })
              return { kind: "output", value: { answer: "done" } }
            },
          },
        }),
      })
      const res = await app.fetch(
        new Request("http://x/agui", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            threadId: "t1",
            runId: "r1",
            forwardedProps: { input: { prompt: "x" } },
          }),
        }),
      )
      return drain(res.body, total * 2)
    },
  },
  {
    name: "mountAgent",
    file: "packages/agent/src/mount.ts",
    unit: "bytes",
    cap: 1024,
    frame: 128,
    flood: async (cap, total) => {
      const app = server()
      mountAgent(app, {
        agent,
        maxOutputBytes: cap,
        ports: () => ({
          capabilities: [],
          model: { complete: () => ({ kind: "output", value: { answer: "x".repeat(total) } }) },
        }),
      })
      const res = await app.fetch(
        new Request("http://x/agent", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({ input: { prompt: "x" } }),
        }),
      )
      return drain(res.body, total * 2)
    },
  },
  {
    name: "respondMcpHttp (tools/call over SSE)",
    file: "packages/mcp/src/http.ts",
    unit: "bytes",
    cap: 1024,
    frame: 256,
    flood: async (cap, total) => {
      // Each progress notification is a frame of about a hundred bytes.
      const steps = Math.ceil(total / 100)
      const tool = defineMcpTool({
        name: "flood",
        description: "Reports progress",
        handler: async (_args, context) => {
          for (let step = 0; step < steps && !context.signal.aborted; step++)
            context.reportProgress(step, steps)
          return "done"
        },
      })
      const res = await respondMcpHttp(
        new Request("http://x/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "flood", _meta: { progressToken: "flood" } },
          }),
        }),
        [tool],
        { name: "invariants", version: "1.0.0" },
        { maxPendingBytes: cap },
      )
      return drain(res.body, total * 2)
    },
  },
  {
    name: "devtools",
    file: "packages/devtools/src/index.ts",
    unit: "bytes",
    cap: 4096,
    frame: 1024,
    flood: async (cap, total) => {
      const app = server()
        .use(devtools({ enabled: true, maxPendingBytes: cap, pingIntervalMs: 60_000 }))
        .get(`/r/:id`, () => "ok")
      const res = await app.fetch(
        new Request("http://127.0.0.1/_nifra/devtools", {
          headers: { accept: "text/event-stream" },
        }),
      )
      // Each served request is one live event of a few hundred bytes.
      for (let i = 0; i < Math.ceil(total / 150); i++)
        await app.fetch(new Request(`http://127.0.0.1/r/${i}`))
      return drain(res.body, total)
    },
  },
  {
    name: "graphql createPubSub",
    file: "packages/graphql/src/pubsub.ts",
    unit: "events",
    cap: 16,
    frame: 0,
    flood: async (cap, total) => {
      const pubsub = createPubSub<number>({ maxQueuedEvents: cap })
      const iterator = pubsub.subscribe("topic")
      for (let i = 0; i < total; i++) pubsub.publish("topic", i)
      let delivered = 0
      try {
        while (delivered < total) {
          const next = await iterator.next()
          if (next.done) break
          delivered++
        }
      } catch {
        // Overflow detaches the subscriber with an error after what it had queued.
      }
      await iterator.return?.()
      return delivered
    },
  },
]

for (const producer of PRODUCERS) {
  describe(producer.name, () => {
    test(`an unread client is held to the cap, not the flood (${producer.unit})`, async () => {
      const flood = producer.cap * 16
      const delivered = await producer.flood(producer.cap, flood)
      expect(delivered).toBeLessThanOrEqual(producer.cap + producer.frame)
    })

    test("control: under a cap above the flood, the flood arrives whole", async () => {
      const flood = producer.cap * 2
      const delivered = await producer.flood(flood * 4, flood)
      expect(delivered).toBeGreaterThanOrEqual(flood)
    })
  })
}

// Event-stream sources not enrolled above, each with why.
const NOT_PRODUCERS: Readonly<Record<string, string>> = {
  "packages/a2a/src/index.ts":
    "bounded by maxOutputBytes per response (a2a tests); its stream carries run evidence, not a flood a test can drive cheaply",
  "packages/coding-agent/src/rpc.ts":
    "pulled, not pushed: turn.send advances the backend only as the client reads, and a resumable follower is dropped past replayBytes (rpc-resume.test)",
  "packages/core/src/server/server.ts": "content-type detection for the native lanes",
  "packages/client/src/client.ts":
    "the client reading a stream; its frame cap is the client-side twin",
  "packages/agent-app/src/transport.ts": "the browser client reading a stream",
  "packages/schema/src/openapi.ts": "documents event-stream responses",
  "packages/web/src/vite.ts": "dev-server module proxy content types",
}

test("every event-stream producer is enrolled or named as not one", async () => {
  const root = new URL("../../../", import.meta.url).pathname
  const sources: string[] = []
  for await (const file of new Bun.Glob("packages/*/src/**/*.ts").scan({ cwd: root })) {
    if (file.startsWith("packages/cli/") || file.startsWith("packages/create-nifra/")) continue
    const source = await Bun.file(`${root}${file}`).text()
    if (/text\/event-stream|maxQueuedEvents/.test(source)) sources.push(file)
  }
  const enrolled = new Set(PRODUCERS.map((producer) => producer.file))
  const unknown = sources.filter((file) => !enrolled.has(file) && NOT_PRODUCERS[file] === undefined)
  const stale = Object.keys(NOT_PRODUCERS).filter((file) => !sources.includes(file))
  expect({ unknown: unknown.sort(), stale }).toEqual({ unknown: [], stale: [] })
})
