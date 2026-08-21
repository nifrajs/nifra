import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { AgentTransportError, HttpAgentTransport } from "../src/transport.ts"

const event = (seq: number): AgentEvent => ({
  version: 1,
  sessionId: "s",
  seq,
  at: seq,
  type: "assistant.delta",
  turnId: "t",
  text: "x",
})

function sse(...events: AgentEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const frames = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
  // Include a comment/heartbeat frame with no data line - it must be skipped, not parsed.
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`: heartbeat\n\n${frames}`))
      controller.close()
    },
  })
}

describe("HttpAgentTransport", () => {
  test("mints a bearer token per request and never persists it", async () => {
    const seenAuth: Array<string | null> = []
    let token = "token-a"
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get("authorization"))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    const transport = new HttpAgentTransport({
      endpoint: "http://127.0.0.1:9",
      authorize: () => token,
      fetch: fetchImpl,
    })
    await transport.command({ method: "a" })
    token = "token-b"
    await transport.command({ method: "b" })
    expect(seenAuth).toEqual(["Bearer token-a", "Bearer token-b"])
    // The credential lives only behind the provider closure, not on the transport instance.
    expect(JSON.stringify(transport)).not.toContain("token-")
  })

  test("returns a bounded outcome for a non-ok command instead of throwing", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch
    const transport = new HttpAgentTransport({ endpoint: "http://127.0.0.1:9", fetch: fetchImpl })
    const outcome = await transport.command({ method: "x" })
    expect(outcome).toEqual({ ok: false, status: 403, error: "nope" })
  })

  test("parses an SSE body into protocol events and skips non-event frames", async () => {
    const fetchImpl = (async () =>
      new Response(sse(event(1), event(2)), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch
    const transport = new HttpAgentTransport({ endpoint: "http://127.0.0.1:9", fetch: fetchImpl })
    const seqs: number[] = []
    for await (const e of transport.stream({ method: "turn.send" })) seqs.push(e.seq)
    expect(seqs).toEqual([1, 2])
  })

  test("wraps a fetch fault as AgentTransportError", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused")
    }) as unknown as typeof fetch
    const transport = new HttpAgentTransport({ endpoint: "http://127.0.0.1:9", fetch: fetchImpl })
    await expect(transport.command({ method: "x" })).rejects.toThrow(AgentTransportError)
  })
})
