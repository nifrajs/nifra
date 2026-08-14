/**
 * The Node-stream claim seam, end to end through the real `@nifrajs/node` adapter.
 *
 * The optimization it exists for is invisible - identical bytes either way - so what these tests
 * actually guard is the failure mode: a body that gets SPLIT between the Web view and the Node
 * stream underneath it, or forwarded truncated because one layer read a little first. Every path
 * that could produce a partial body is asserted to fall back to the ordinary Web conversion rather
 * than to claim.
 *
 * Node lane, for the same reason as `undici-transport.test.ts`: `undiciTransport()` refuses to
 * construct under Bun.
 */

import assert from "node:assert/strict"
import http from "node:http"
import { Readable } from "node:stream"
import { after, before, describe, test } from "node:test"
import { server as nifraServer } from "@nifrajs/core"
import { serve } from "@nifrajs/node"
import { createProxy, type ProxyTransport } from "@nifrajs/proxy"
// The seam itself is internal - reached by path, not promoted to public API for a test.
import { claimableWebStream, claimNodeStream } from "../src/node-stream.ts"

const underBun = typeof (globalThis as { readonly Bun?: unknown }).Bun !== "undefined"
const suite = underBun ? describe.skip : describe

let lazyTransport: ProxyTransport | undefined
const transport: ProxyTransport = async (target, request) => {
  if (lazyTransport === undefined) {
    const { undiciTransport } = await import("@nifrajs/proxy/undici")
    lazyTransport = undiciTransport()
  }
  return lazyTransport(target, request)
}

// --- Origin: echoes what it actually received, so a truncated relay cannot pass. ---

let received: { method: string; length: number; digest: string } = {
  method: "",
  length: 0,
  digest: "",
}

const origin = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on("data", (chunk: Buffer) => chunks.push(chunk))
  req.on("end", () => {
    const body = Buffer.concat(chunks)
    received = {
      method: req.method ?? "",
      length: body.length,
      digest: `${body.subarray(0, 4).toString("hex")}:${body.subarray(-4).toString("hex")}`,
    }
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream" })
      res.end(Buffer.alloc(3_000_000, 9))
      return
    }
    // Answers late enough that a client can leave while the upstream is still in flight.
    if (req.url === "/delayed") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/octet-stream" })
        res.end(Buffer.alloc(64 * 1024, 3))
      }, 40)
      return
    }
    // Never finishes on its own: only a teardown from the far end can end this response.
    if (req.url === "/slow") {
      res.writeHead(200, { "content-type": "application/octet-stream" })
      res.write(Buffer.alloc(64 * 1024, 1))
      const timer = setInterval(() => void res.write(Buffer.alloc(64 * 1024, 1)), 5)
      res.on("close", () => {
        clearInterval(timer)
        slowClosed?.()
      })
      return
    }
    // Promises a megabyte, then kills the socket: the relay must not pass this off as a clean 200.
    if (req.url === "/truncate") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": "1000000",
      })
      res.write(Buffer.alloc(1024, 2))
      setTimeout(() => res.socket?.destroy(), 20)
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(received))
  })
})

let slowClosed: (() => void) | undefined
let originPort = 0
let proxyPort = 0
let stop: (() => Promise<void>) | undefined

// A body big enough to span many chunks: a one-chunk body cannot show a split.
const PAYLOAD = Buffer.alloc(512 * 1024).map((_, i) => (i % 251) as number)

before(async () => {
  if (underBun) return
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve))
  originPort = (origin.address() as { port: number }).port

  const proxy = createProxy({ upstream: `http://127.0.0.1:${originPort}`, transport })
  const app = nifraServer().mountFetch("/", proxy)
  const handle = await serve(app, { port: 0 })
  proxyPort = handle.port
  stop = () => handle.stop()
})

after(async () => {
  if (underBun) return
  await stop?.()
  await new Promise<void>((resolve) => origin.close(() => resolve()))
})

const post = async (path: string, body: BodyInit, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${proxyPort}${path}`, { method: "POST", body, ...init })

suite("node-stream claim seam", () => {
  test("a claimed POST body reaches the origin whole", async () => {
    const response = await post("/echo", new Uint8Array(PAYLOAD))
    assert.equal(response.status, 200)
    const seen = (await response.json()) as typeof received
    assert.equal(seen.method, "POST")
    assert.equal(seen.length, PAYLOAD.length)
    assert.equal(
      seen.digest,
      `${PAYLOAD.subarray(0, 4).toString("hex")}:${PAYLOAD.subarray(-4).toString("hex")}`,
    )
  })

  test("a claimed GET response body reaches the client whole", async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/big`)
    assert.equal(response.status, 200)
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert.equal(bytes.length, 3_000_000)
    assert.equal(bytes[0], 9)
    assert.equal(bytes[bytes.length - 1], 9)
  })

  // --- Teardown, end to end. These hold today through the request's abort signal rather than
  // through anything the claimed path does itself, which is exactly why they are asserted here:
  // the claimed path bypasses the Web reader loop, so nothing else would notice if it stopped
  // holding. Both fail as a hang or a silently-short body, never as a loud error. ---

  test("a client hanging up tears the upstream body down", async () => {
    const closed = new Promise<void>((resolve) => {
      slowClosed = resolve
    })
    const abort = new AbortController()
    const response = await fetch(`http://127.0.0.1:${proxyPort}/slow`, { signal: abort.signal })
    await response.body!.getReader().read()
    abort.abort()

    // Without the teardown the origin keeps writing into a buffer and never sees its socket close.
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000))
    assert.notEqual(await Promise.race([closed.then(() => "closed" as const), timeout]), "timeout")
    slowClosed = undefined
  })

  test("a client that leaves before the body is written does not take the process down", async () => {
    // Clients leaving while the upstream is in flight: the relay ends up destroying an upstream
    // body it never piped, and destroying one emits `error`, which unhandled is a process kill -
    // a disconnecting client would be a remote shutdown. This asserts the server keeps serving
    // afterwards. It is a resilience check rather than a reproduction: the exact window needs
    // sustained load to land reliably, and it is the proxy benchmark under `oha` that hits it.
    await Promise.all(
      Array.from({ length: 40 }, async () => {
        const abort = new AbortController()
        const pending = fetch(`http://127.0.0.1:${proxyPort}/delayed`, { signal: abort.signal })
        setTimeout(() => abort.abort(), 20)
        await pending.then((r) => r.arrayBuffer()).catch(() => undefined)
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    const response = await post("/echo", new Uint8Array(PAYLOAD))
    assert.equal(response.status, 200)
    assert.equal(((await response.json()) as typeof received).length, PAYLOAD.length)
  })

  test("an upstream that dies mid-body aborts the response rather than truncating it", async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/truncate`)
    // The status is already flushed by the time the upstream fails, so the only honest signal left
    // is a broken transfer - never a 200 that is quietly 1 KB instead of 1 MB.
    assert.equal(response.status, 200)
    await assert.rejects(() => response.arrayBuffer())
  })

  test("an empty POST body still relays", async () => {
    const response = await post("/echo", "")
    const seen = (await response.json()) as typeof received
    assert.equal(seen.length, 0)
  })

  // --- The unit-level safety properties. Each `null` here is a body that would otherwise be
  // forwarded with a hole in it. ---

  test("claim is refused once the Web view has been read", async () => {
    const source = Readable.from([Buffer.from("abcd"), Buffer.from("efgh")])
    const web = claimableWebStream(source)
    const reader = web.getReader()
    await reader.read()
    reader.releaseLock()
    assert.equal(claimNodeStream(web), null)
  })

  test("claim is refused while a reader holds the stream", () => {
    const web = claimableWebStream(Readable.from([Buffer.from("x")]))
    web.getReader()
    assert.equal(claimNodeStream(web), null)
  })

  test("claim is one-shot", () => {
    const source = Readable.from([Buffer.from("x")])
    const web = claimableWebStream(source)
    assert.equal(claimNodeStream(web), source)
    assert.equal(claimNodeStream(web), null)
  })

  test("a foreign Web stream is never claimed", () => {
    assert.equal(claimNodeStream(new ReadableStream<Uint8Array>()), null)
    assert.equal(claimNodeStream(null), null)
  })

  test("a forged claim that does not yield a Node stream is refused", () => {
    // The key is `Symbol.for`, so anything in the process can reach it. The value is not trusted.
    const web = new ReadableStream<Uint8Array>()
    Object.defineProperty(web, Symbol.for("nifra.node.stream-claim"), {
      value: { claim: () => ({ pipe: () => undefined, read: () => null }) },
    })
    assert.equal(claimNodeStream(web), null)
  })

  test("a destroyed source is not handed over", () => {
    const source = Readable.from([Buffer.from("x")])
    source.destroy()
    assert.equal(claimNodeStream(claimableWebStream(source)), null)
  })

  test("reading a surrendered stream errors instead of serving a split body", async () => {
    const source = Readable.from([Buffer.from("abcd")])
    const web = claimableWebStream(source)
    assert.equal(claimNodeStream(web), source)
    await assert.rejects(() => web.getReader().read())
  })

  test("cancelling the Web view destroys the Node stream underneath", () => {
    const source = Readable.from([Buffer.from("x")])
    const web = claimableWebStream(source)
    void web.cancel()
    assert.equal(source.destroyed, true)
    assert.equal(claimNodeStream(web), null)
  })

  test("the lazy wrapper does not read its source until pulled", async () => {
    const source = Readable.from([Buffer.from("abcd")])
    const web = claimableWebStream(source)
    await new Promise((resolve) => setImmediate(resolve))
    // `Readable.toWeb` fails this: it consumes eagerly, which is why the seam cannot use it.
    assert.equal(source.readableDidRead, false)
    const first = await web.getReader().read()
    assert.equal(Buffer.from(first.value as Uint8Array).toString(), "abcd")
  })

  test("the wrapper relays a source error rather than truncating silently", async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error("upstream exploded"))
      },
    })
    await assert.rejects(() => claimableWebStream(source).getReader().read(), /upstream exploded/)
  })
})
