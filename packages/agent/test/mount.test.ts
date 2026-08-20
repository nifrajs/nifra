import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { createMemoryAgentEvidenceLog } from "../src/events.ts"
import type { AgentModelPort, AgentPorts } from "../src/index.ts"
import { type AgentMountableApp, type AgentRouteContext, mountAgent } from "../src/mount.ts"

const input = t.object({ prompt: t.string() })
const output = t.object({ answer: t.string() })

const definition = {
  name: "reference-agent",
  instruction: "Return a concise answer.",
  input,
  output,
  tools: [],
}

function captureApp(): {
  readonly app: AgentMountableApp
  call(req: Request): Promise<Response>
} {
  let handler: ((c: AgentRouteContext) => Response | Promise<Response>) | undefined
  return {
    app: {
      post: (_path, h) => {
        handler = h
      },
    },
    call: (req) => {
      if (handler === undefined) throw new Error("no handler mounted")
      return Promise.resolve(handler({ req }))
    },
  }
}

function outputModel(value: unknown): AgentModelPort {
  return { complete: () => ({ kind: "output", value }) }
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://local/agent", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function ports(model: AgentModelPort): (c: AgentRouteContext) => AgentPorts {
  return () => ({ model, capabilities: [] })
}

describe("mountAgent", () => {
  test("runs a completed turn and returns the projected result as JSON", async () => {
    const { app, call } = captureApp()
    mountAgent(app, { agent: definition, ports: ports(outputModel({ answer: "hi" })) })

    const res = await call(post({ input: { prompt: "hey" } }))
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.status).toBe("completed")
    expect(json.ok).toBe(true)
    expect(json.output).toEqual({ answer: "hi" })
    expect(typeof json.turnId).toBe("string")
  })

  test("echoes a caller-supplied turnId", async () => {
    const { app, call } = captureApp()
    mountAgent(app, { agent: definition, ports: ports(outputModel({ answer: "ok" })) })

    const res = await call(post({ input: { prompt: "hey" }, turnId: "run-42" }))
    const json = (await res.json()) as Record<string, unknown>
    expect(json.turnId).toBe("run-42")
  })

  test("negotiates an SSE evidence stream on Accept", async () => {
    const { app, call } = captureApp()
    mountAgent(app, { agent: definition, ports: ports(outputModel({ answer: "streamed" })) })

    const res = await call(post({ input: { prompt: "hey" } }, { accept: "text/event-stream" }))
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain("event: step")
    expect(text).toContain("event: result")
    expect(text).toContain("streamed")
  })

  test("streaming composes with a caller-injected telemetry port instead of replacing it", async () => {
    const { app, call } = captureApp()
    const seen: string[] = []
    mountAgent(app, {
      agent: definition,
      ports: () => ({
        model: outputModel({ answer: "hi" }),
        capabilities: [],
        telemetry: {
          step: (evidence) => {
            seen.push(`${evidence.kind}:${evidence.outcome}`)
          },
        },
      }),
    })

    const res = await call(post({ input: { prompt: "hey" } }, { accept: "text/event-stream" }))
    const text = await res.text()
    expect(text).toContain("event: step")
    expect(seen).toContain("model:started")
    expect(seen).toContain("model:passed")
  })

  test("rejects a non-object body", async () => {
    const { app, call } = captureApp()
    mountAgent(app, { agent: definition, ports: ports(outputModel({ answer: "hi" })) })

    const res = await call(post([1, 2, 3]))
    expect(res.status).toBe(400)
    expect((await res.json()) as Record<string, unknown>).toEqual({ error: "body_must_be_object" })
  })

  test("rejects an unreadable body", async () => {
    const { app, call } = captureApp()
    mountAgent(app, { agent: definition, ports: ports(outputModel({ answer: "hi" })) })

    const res = await call(post("not json at all"))
    expect(res.status).toBe(400)
  })

  test("projects an invalid turnId to 400", async () => {
    const { app, call } = captureApp()
    mountAgent(app, { agent: definition, ports: ports(outputModel({ answer: "hi" })) })

    const res = await call(post({ input: { prompt: "hey" }, turnId: "has spaces and is way too" }))
    expect(res.status).toBe(400)
    expect((await res.json()) as Record<string, unknown>).toEqual({ error: "invalid_turn_id" })
  })
})

describe("mountAgent resumable streams", () => {
  test("stamps step frames with ids and replays a finished turn from Last-Event-ID", async () => {
    const { app, call } = captureApp()
    mountAgent(app, {
      agent: definition,
      ports: ports(outputModel({ answer: "kept" })),
      evidenceLog: createMemoryAgentEvidenceLog(),
    })

    const first = await call(
      post({ input: { prompt: "hey" }, turnId: "run-replay" }, { accept: "text/event-stream" }),
    )
    const firstText = await first.text()
    expect(firstText).toContain("id: ")
    expect(firstText).toContain("event: result")

    const replay = await call(
      post(
        { input: { prompt: "hey" }, turnId: "run-replay" },
        { accept: "text/event-stream", "last-event-id": "0" },
      ),
    )
    expect(replay.headers.get("content-type")).toContain("text/event-stream")
    const replayText = await replay.text()
    expect(replayText).toContain("event: result")
    expect(replayText).toContain("kept")
  })

  test("a reconnect rejoins a still-running turn without starting a second run", async () => {
    const { app, call } = captureApp()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let completions = 0
    const model: AgentModelPort = {
      complete: async () => {
        await gate
        completions += 1
        return { kind: "output", value: { answer: "late" } }
      },
    }
    mountAgent(app, {
      agent: definition,
      ports: ports(model),
      evidenceLog: createMemoryAgentEvidenceLog(),
    })

    const first = await call(
      post({ input: { prompt: "hey" }, turnId: "run-live" }, { accept: "text/event-stream" }),
    )
    const rejoin = await call(
      post(
        { input: { prompt: "hey" }, turnId: "run-live" },
        { accept: "text/event-stream", "last-event-id": "0" },
      ),
    )
    release()
    const [firstText, rejoinText] = await Promise.all([first.text(), rejoin.text()])
    expect(firstText).toContain("late")
    expect(rejoinText).toContain("event: result")
    expect(rejoinText).toContain("late")
    expect(completions).toBe(1)
  })

  test("rejects an unknown replay and a malformed Last-Event-ID", async () => {
    const { app, call } = captureApp()
    mountAgent(app, {
      agent: definition,
      ports: ports(outputModel({ answer: "hi" })),
      evidenceLog: createMemoryAgentEvidenceLog(),
    })

    const unknown = await call(
      post(
        { input: { prompt: "hey" }, turnId: "never-ran" },
        { accept: "text/event-stream", "last-event-id": "3" },
      ),
    )
    expect(unknown.status).toBe(409)
    expect((await unknown.json()) as Record<string, unknown>).toEqual({
      error: "replay_unavailable",
    })

    const malformed = await call(
      post(
        { input: { prompt: "hey" }, turnId: "never-ran" },
        { accept: "text/event-stream", "last-event-id": "not-a-seq" },
      ),
    )
    expect(malformed.status).toBe(400)
  })
})
