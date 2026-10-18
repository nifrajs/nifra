import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import {
  AgentTransportError,
  AgentTurnError,
  HttpAgentTransport,
  parseEventStream,
} from "../src/transport.ts"

const event = (seq: number): Extract<AgentEvent, { type: "assistant.delta" }> => ({
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

describe("a terminal error frame", () => {
  const failing = (data: string): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        const frames = `data: ${JSON.stringify(event(1))}\n\nevent: error\ndata: ${data}\n\n`
        controller.enqueue(new TextEncoder().encode(frames))
        controller.close()
      },
    })
  const outcome = async (data: string) => {
    const seqs: number[] = []
    try {
      for await (const value of parseEventStream(failing(data), "turn.attach")) seqs.push(value.seq)
    } catch (error) {
      if (!(error instanceof AgentTurnError)) throw error
      return { seqs, method: error.method, code: error.code, message: error.message }
    }
    throw new Error("expected the turn to fail")
  }

  test("rejects the turn with the host's failure code after the events before it", async () => {
    expect(await outcome(JSON.stringify({ code: "response_too_large" }))).toEqual({
      seqs: [1],
      method: "turn.attach",
      code: "response_too_large",
      message: "agent turn: turn.attach: response_too_large",
    })
  })

  test("never carries a code it cannot trust", async () => {
    for (const data of [
      JSON.stringify({ code: "Leaked detail: /home/user/.env" }),
      JSON.stringify({ code: 7 }),
      JSON.stringify("text"),
      "not json",
      "",
    ])
      expect((await outcome(data)).code).toBe("turn_failed")
  })
})

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

  test("a failing authorize() is reported without its message, before any request", async () => {
    const credential = "refresh-credential-SYNTHETIC-0123456789"
    let fetched = 0
    const transport = new HttpAgentTransport({
      endpoint: "http://127.0.0.1:9",
      authorize: () => {
        throw new Error(`refresh failed for ${credential}`)
      },
      fetch: Object.assign(
        async () => {
          fetched++
          return new Response("{}")
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const command = await transport.command({ method: "a" }).catch((error: unknown) => error)
    const stream = await Array.fromAsync(transport.stream({ method: "turn.attach" })).catch(
      (error: unknown) => error,
    )
    for (const error of [command, stream]) {
      if (!(error instanceof AgentTransportError)) throw new Error("expected AgentTransportError")
      expect(error.message).toMatch(/: authorize\(\) failed$/)
      expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain(credential)
    }
    expect(fetched).toBe(0)
  })

  test("returns a bounded outcome for a non-ok command, and a refused stream carries its status", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch
    const transport = new HttpAgentTransport({ endpoint: "http://127.0.0.1:9", fetch: fetchImpl })
    const outcome = await transport.command({ method: "x" })
    expect(outcome).toEqual({ ok: false, status: 403, error: "nope" })
    const refused = await Array.fromAsync(transport.stream({ method: "turn.attach" })).catch(
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(AgentTransportError)
    expect(refused instanceof AgentTransportError ? refused.status : undefined).toBe(403)
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

  test("does linear encoding work for a valid frame fragmented into small chunks", async () => {
    const value: AgentEvent = { ...event(9), text: "x".repeat(200_000) }
    const payload = new TextEncoder().encode(`data: ${JSON.stringify(value)}\r\n\r\n`)
    const measure = async (chunkSize: number): Promise<number> => {
      let offset = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === payload.length) {
            controller.close()
            return
          }
          const end = Math.min(payload.length, offset + chunkSize)
          controller.enqueue(payload.slice(offset, end))
          offset = end
        },
      })
      const originalEncode = TextEncoder.prototype.encode
      let encodedBytes = 0
      TextEncoder.prototype.encode = function (input) {
        const encoded = originalEncode.call(this, input)
        encodedBytes += encoded.byteLength
        return encoded
      }
      try {
        expect(await Array.fromAsync(parseEventStream(body, "test.stream"))).toEqual([value])
      } finally {
        TextEncoder.prototype.encode = originalEncode
      }
      return encodedBytes
    }

    const completeWork = await measure(payload.length)
    const fragmentedWork = await measure(17)
    expect(fragmentedWork).toBe(completeWork)
    expect(fragmentedWork).toBeLessThanOrEqual(payload.byteLength * 2)
  })

  test("retains byte-exact UTF-8 caps when emoji and mixed delimiters split at every byte", async () => {
    const encoder = new TextEncoder()
    const value: AgentEvent = { ...event(10), text: "🙂".repeat(300) }
    const frame = `data: ${JSON.stringify(value)}`
    const frameBytes = encoder.encode(frame).byteLength
    const source = (text: string): ReadableStream<Uint8Array> => {
      const bytes = encoder.encode(text)
      let offset = 0
      return new ReadableStream({
        pull(controller) {
          if (offset === bytes.length) controller.close()
          else controller.enqueue(bytes.slice(offset, ++offset))
        },
      })
    }

    // The cap excludes completed delimiters, but includes a trailing, unfinished line ending.
    expect(
      await Array.fromAsync(parseEventStream(source(`${frame}\n\n`), "test", frameBytes + 1)),
    ).toEqual([value])
    await expect(
      Array.fromAsync(parseEventStream(source(`${frame}\n\n`), "test", frameBytes - 1)),
    ).rejects.toThrow(/SSE frame exceeds/)

    for (const delimiter of ["\n\n", "\r\n\r\n", "\r\r", "\r\n\n", "\n\r\n", "\r\n\r", "\r\r\n"])
      expect(
        await Array.fromAsync(
          parseEventStream(source(`${frame}${delimiter}${frame}${delimiter}`), "test"),
        ),
      ).toEqual([value, value])
  })
})
