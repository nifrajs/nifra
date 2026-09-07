import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { AgentTransportError, HttpAgentTransport, parseEventStream } from "../src/transport.ts"

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

  test("bounds command response bodies before parsing them", async () => {
    const fetchImpl = (async () =>
      new Response("x".repeat(2_000), { status: 200 })) as unknown as typeof fetch
    const transport = new HttpAgentTransport({
      endpoint: "http://127.0.0.1:9",
      fetch: fetchImpl,
      maxResponseBytes: 1_024,
    })
    await expect(transport.command({ method: "x" })).rejects.toThrow(/response body exceeds/)
  })

  test("parses CRLF frames split across chunks and flushes a final EOF frame", async () => {
    const encoder = new TextEncoder()
    const first = `data: ${JSON.stringify(event(3))}\r\n\r\n`
    const final = `data: ${JSON.stringify(event(4))}\r\n`
    const payload = `${first}${final}`
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of [payload.slice(0, 7), payload.slice(7, 41), payload.slice(41)])
          controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    const seqs: number[] = []
    for await (const value of parseEventStream(body, "test.stream")) seqs.push(value.seq)
    expect(seqs).toEqual([3, 4])
  })

  test("cancels the response body when a consumer exits an SSE stream early", async () => {
    const encoder = new TextEncoder()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event(5))}\n\n`))
      },
      cancel() {
        cancelled = true
      },
    })
    const iterator = parseEventStream(body, "test.stream")[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.seq).toBe(5)
    await iterator.return?.()
    expect(cancelled).toBe(true)
  })

  test("supports mixed SSE line endings and rejects an unterminated oversized frame", async () => {
    const encoder = new TextEncoder()
    const mixed = `data: ${JSON.stringify(event(6))}\r\n\ndata: ${JSON.stringify(event(7))}\n\r\n`
    const values: number[] = []
    for await (const value of parseEventStream(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(mixed))
          controller.close()
        },
      }),
      "test.stream",
    ))
      values.push(value.seq)
    expect(values).toEqual([6, 7])

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${"x".repeat(2_000)}`))
      },
    })
    await expect(
      (async () => {
        for await (const _event of parseEventStream(oversized, "test.stream", 1_024)) return _event
        return undefined
      })(),
    ).rejects.toThrow(/SSE frame exceeds/)

    const completeOversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ ...event(8), text: "x".repeat(2_000) })}\n\n`),
        )
        controller.close()
      },
    })
    await expect(
      (async () => {
        for await (const _event of parseEventStream(completeOversized, "test.stream", 1_024))
          return _event
        return undefined
      })(),
    ).rejects.toThrow(/SSE frame exceeds/)
  })
})
