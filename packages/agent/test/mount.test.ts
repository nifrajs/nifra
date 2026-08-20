import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
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
