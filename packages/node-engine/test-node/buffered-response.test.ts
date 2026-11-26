import assert from "node:assert/strict"
import { once } from "node:events"
import { get } from "node:http"
import { connect } from "node:http2"
import { connect as connectTcp } from "node:net"
import type { Readable } from "node:stream"
import { test } from "node:test"
import { type FetchHandler, serve } from "../src/index.ts"
import { sleep } from "./support.ts"

interface PausedResponse {
  readonly status: number
  readonly contentLength: number
  readonly body: Readable
  disconnect(): void
  close(): void
}

function pausedResponse(port: number, http2: boolean): Promise<PausedResponse> {
  const signal = AbortSignal.timeout(5000)
  if (!http2) {
    return new Promise((resolve, reject) => {
      const req = get(`http://127.0.0.1:${port}/`, { signal }, (response) => {
        response.pause()
        resolve({
          status: response.statusCode ?? 0,
          contentLength: Number(response.headers["content-length"]),
          body: response,
          disconnect: () => response.destroy(),
          close: () => response.destroy(),
        })
      })
      req.on("error", reject)
    })
  }
  const socket = connectTcp(port, "127.0.0.1")
  const session = connect(`http://127.0.0.1:${port}`, { createConnection: () => socket })
  const stream = session.request({ ":path": "/" }, { signal })
  stream.pause()
  return new Promise<PausedResponse>((resolve, reject) => {
    session.on("error", reject)
    stream.on("error", reject)
    stream.once("response", (headers) =>
      resolve({
        status: Number(headers[":status"]),
        contentLength: Number(headers["content-length"]),
        body: stream,
        // An EOF can be a TCP half-close. Reset the socket to signal complete transport loss.
        disconnect: () => socket.resetAndDestroy(),
        close: () => session.destroy(),
      }),
    )
  }).catch((error: unknown) => {
    session.destroy()
    throw error
  })
}

function bufferedApp(
  body: string | Uint8Array,
  observe?: (signal: AbortSignal) => void,
): FetchHandler {
  return {
    fetch() {
      throw new Error("expected the node-direct response")
    },
    resolveNodeSource(source) {
      if (observe !== undefined) {
        assert.ok(typeof source === "object" && source !== null && "request" in source)
        assert.ok(source.request instanceof Request)
        observe(source.request.signal)
      }
      return {
        kind: "body",
        status: 200,
        body,
        headers: { "content-type": "application/octet-stream" },
      }
    },
  }
}

for (const http2 of [false, true]) {
  const protocol = http2 ? "HTTP/2" : "HTTP/1.1"
  // The body exceeds the engine's buffered cutoff and the client's receive window.
  // Give the binary view a nonzero offset to check that framing writes only its bytes.
  const text = "héllo, 世界\n".repeat(650_000)
  const bytes = Buffer.from(`prefix${text}suffix`)
  const body = http2 ? bytes.subarray(6, -6) : text
  const expected = Buffer.from(text)

  test(`${protocol} sends a large node-direct body byte for byte to a slow reader`, async () => {
    const server = await serve(bufferedApp(body), { port: 0, hostname: "127.0.0.1", http2 })
    let response: PausedResponse | undefined
    try {
      response = await pausedResponse(server.port, http2)
      assert.equal(response.status, 200)
      assert.equal(response.contentLength, expected.byteLength)
      await sleep(25) // Leave the reader paused while the transport fills its buffer.
      const chunks: Buffer[] = []
      for await (const chunk of response.body) chunks.push(chunk)
      assert.deepEqual(Buffer.concat(chunks), expected)
    } finally {
      response?.close()
      await server.stop({ drainMs: 0 })
    }
  })

  test(`${protocol} aborts a large node-direct response when the paused reader disconnects`, async () => {
    const request = Promise.withResolvers<AbortSignal>()
    const server = await serve(bufferedApp(body, request.resolve), {
      port: 0,
      hostname: "127.0.0.1",
      http2,
    })
    let response: PausedResponse | undefined
    try {
      response = await pausedResponse(server.port, http2)
      const signal = await request.promise
      assert.equal(response.status, 200)
      assert.equal(signal.aborted, false)
      const aborted = once(signal, "abort", { signal: AbortSignal.timeout(3000) })
      response.disconnect()
      await aborted
    } finally {
      response?.close()
      await server.stop({ drainMs: 0 })
    }
  })
}
