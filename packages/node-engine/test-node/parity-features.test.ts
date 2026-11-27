/** Integration coverage for PR 1 engine parity features: SNI, UDS, compression, static/fastResponse, streaming request bodies, WS backpressure/reason/deflate/RFC 8441. */

import assert from "node:assert/strict"
import { randomBytes, X509Certificate } from "node:crypto"
import { closeSync } from "node:fs"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { connect as http2Connect } from "node:http2"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { type ConnectionOptions, connect as tlsConnect } from "node:tls"
import * as zlib from "node:zlib"
import { server } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { WebSocket as WsClient } from "ws"
import { selfSignedCertificate } from "../../../internal/test-utils/src/tls.ts"
import { isNativeAvailable, probe, serve, serveStatic } from "../src/index.ts"
import { bindSharedListenerSocket } from "../src/serve.ts"

const fingerprintOf = (pem: string): string => new X509Certificate(pem).fingerprint256

function tlsFingerprintForSni(
  port: number,
  servername: string | undefined,
  trustedCa: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tlsOpts: ConnectionOptions = {
      port,
      host: "127.0.0.1",
      ca: trustedCa,
      checkServerIdentity: () => undefined,
    }
    if (servername !== undefined) tlsOpts.servername = servername
    const sock = tlsConnect(tlsOpts, () => {
      const fp = sock.getPeerCertificate().fingerprint256
      sock.destroy()
      resolve(fp)
    })
    sock.on("error", reject)
  })
}

function encodeClientWsFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = randomBytes(4)
  const len = payload.byteLength
  let header: Buffer
  if (len < 126) {
    header = Buffer.allocUnsafe(6)
    header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
    header[1] = 0x80 | len
    mask.copy(header, 2)
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(8)
    header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
    mask.copy(header, 4)
  } else {
    header = Buffer.allocUnsafe(14)
    header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
    mask.copy(header, 10)
  }
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) {
    masked[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0)
  }
  return Buffer.concat([header, masked])
}

function decodeServerWsFrame(
  buf: Buffer,
): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buf.byteLength < 2) return null
  const first = buf[0] ?? 0
  const second = buf[1] ?? 0
  let len = second & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.byteLength < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.byteLength < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  if (buf.byteLength < offset + len) return null
  return {
    opcode: first & 0x0f,
    payload: buf.subarray(offset, offset + len),
    consumed: offset + len,
  }
}

test("TLS SNI selects exact, wildcard, fallback, and runtime-added/removed certs", async () => {
  const [defCert, exactCert, wildCert, runtimeCert] = await Promise.all([
    selfSignedCertificate(),
    selfSignedCertificate(),
    selfSignedCertificate(),
    selfSignedCertificate(),
  ])
  const running = await serve(
    server().get("/ok", () => ({ ok: true })),
    {
      port: 0,
      hostname: "127.0.0.1",
      tls: {
        cert: defCert.cert,
        key: defCert.key,
        serverNames: [
          { serverName: "api.example.test", cert: exactCert.cert, key: exactCert.key },
          { serverName: "*.wild.test", cert: wildCert.cert, key: wildCert.key },
        ],
      },
    },
  )
  try {
    assert.equal(
      await tlsFingerprintForSni(running.port, "api.example.test", exactCert.cert),
      fingerprintOf(exactCert.cert),
    )
    assert.equal(
      await tlsFingerprintForSni(running.port, "sub.wild.test", wildCert.cert),
      fingerprintOf(wildCert.cert),
    )
    assert.equal(
      await tlsFingerprintForSni(running.port, "a.b.wild.test", defCert.cert),
      fingerprintOf(defCert.cert),
    )
    assert.equal(
      await tlsFingerprintForSni(running.port, "unknown.test", defCert.cert),
      fingerprintOf(defCert.cert),
    )

    running.addServerName({
      serverName: "dyn.example.test",
      cert: runtimeCert.cert,
      key: runtimeCert.key,
    })
    assert.equal(
      await tlsFingerprintForSni(running.port, "dyn.example.test", runtimeCert.cert),
      fingerprintOf(runtimeCert.cert),
    )
    assert.equal(running.removeServerName("dyn.example.test"), true)
    assert.equal(running.removeServerName("dyn.example.test"), false)
    assert.equal(
      await tlsFingerprintForSni(running.port, "dyn.example.test", defCert.cert),
      fingerprintOf(defCert.cert),
    )
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("Unix domain socket listener answers GET and POST over serve({ path })", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nifra-uds-"))
  const sockPath = join(dir, "app.sock")
  const running = await serve(
    server()
      .get("/hello", () => ({ transport: "unix" }))
      .post("/echo", async (c) => ({ body: await c.req.text() })),
    { path: sockPath },
  )
  try {
    assert.equal(running.path, sockPath)
    const getBody = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ socketPath: sockPath, path: "/hello", method: "GET" }, (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      })
      req.on("error", reject)
      req.end()
    })
    assert.deepEqual(JSON.parse(getBody), { transport: "unix" })

    const postBody = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ socketPath: sockPath, path: "/echo", method: "POST" }, (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      })
      req.on("error", reject)
      req.end("unix-payload")
    })
    assert.deepEqual(JSON.parse(postBody), { body: "unix-payload" })

    await running.stop({ drainMs: 50 })
    await assert.rejects(() => stat(sockPath))
    // Re-binding the exact same socket path succeeds after stop() unlinked the owned file.
    const rebound = await serve(
      server().get("/hello", () => ({ rebound: true })),
      {
        path: sockPath,
      },
    )
    try {
      const rb = await new Promise<string>((resolve, reject) => {
        const req = httpRequest({ socketPath: sockPath, path: "/hello", method: "GET" }, (res) => {
          const chunks: Buffer[] = []
          res.on("data", (c) => chunks.push(c))
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
        })
        req.on("error", reject)
        req.end()
      })
      assert.deepEqual(JSON.parse(rb), { rebound: true })
    } finally {
      await rebound.stop({ drainMs: 50 })
    }
  } finally {
    await running.stop({ drainMs: 50 })
    await rm(dir, { recursive: true, force: true })
  }
})

test("native compression negotiates br/gzip/deflate by quality and respects minBytes & explicit encoding", async () => {
  const big = "x".repeat(4096)
  const small = "ok"
  const app = server()
    .get("/big", () => ({ data: big }))
    .get("/small", () => ({ data: small }))
    .get(
      "/pre",
      () =>
        new Response(big, {
          headers: { "content-type": "text/plain", "content-encoding": "identity" },
        }),
    )
    .get(
      "/vary-origin",
      () =>
        new Response(JSON.stringify({ data: big }), {
          headers: { "content-type": "application/json", vary: "Origin" },
        }),
    )
    .get("/img", () => new Response(big, { headers: { "content-type": "image/png" } }))
  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    compression: { minBytes: 512 },
  })
  try {
    const reqEnc = (
      path: string,
      ae: string,
    ): Promise<{ ce: string | null; vary: string | null; body: Buffer }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          { port: running.port, host: "127.0.0.1", path, headers: { "accept-encoding": ae } },
          (res) => {
            const chunks: Buffer[] = []
            res.on("data", (c) => chunks.push(c))
            res.on("end", () =>
              resolve({
                ce:
                  typeof res.headers["content-encoding"] === "string"
                    ? res.headers["content-encoding"]
                    : null,
                vary: typeof res.headers.vary === "string" ? res.headers.vary : null,
                body: Buffer.concat(chunks),
              }),
            )
          },
        )
        req.on("error", reject)
        req.end()
      })

    const br = await reqEnc("/big", "gzip;q=0.5, br;q=0.9")
    assert.equal(br.ce, "br")
    assert.match(br.vary ?? "", /accept-encoding/i)
    assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(br.body).toString("utf8")), { data: big })

    const gz = await reqEnc("/big", "deflate;q=0.4, gzip;q=0.8")
    assert.equal(gz.ce, "gzip")
    assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.body).toString("utf8")), { data: big })

    const df = await reqEnc("/big", "deflate")
    assert.equal(df.ce, "deflate")
    assert.deepEqual(JSON.parse(zlib.inflateSync(df.body).toString("utf8")), { data: big })

    const idResp = await reqEnc("/big", "identity")
    assert.equal(idResp.ce, null)
    assert.match(idResp.vary ?? "", /accept-encoding/i)

    const varyOrigin = await reqEnc("/vary-origin", "gzip")
    assert.equal(varyOrigin.ce, "gzip")
    assert.match(varyOrigin.vary ?? "", /origin/i)
    assert.match(varyOrigin.vary ?? "", /accept-encoding/i)

    assert.equal((await reqEnc("/small", "br, gzip")).ce, null)
    assert.equal((await reqEnc("/pre", "br, gzip")).ce, "identity")
    assert.equal((await reqEnc("/img", "br, gzip")).ce, null)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("static and fastResponse parity with @nifrajs/node", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nifra-static-"))
  await writeFile(join(dir, "hello.txt"), "from-disk")
  await writeFile(join(dir, ".secret"), "nope")
  const app = server()
    .get("/hello.txt", () => ({ shadowed: true }))
    .get("/fast", () => new Response("fast-ok"))
  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    static: serveStatic({ dir, prefix: "/", fallthrough: true }),
    fastResponse: true,
  })
  try {
    const fileRes = await fetch(`http://127.0.0.1:${running.port}/hello.txt`)
    assert.equal(fileRes.status, 200)
    assert.equal(await fileRes.text(), "from-disk")

    const dotRes = await fetch(`http://127.0.0.1:${running.port}/.secret`)
    assert.equal(dotRes.status, 404)

    const fastRes = await fetch(`http://127.0.0.1:${running.port}/fast`)
    assert.equal(fastRes.status, 200)
    assert.equal(await fastRes.text(), "fast-ok")
  } finally {
    await running.stop({ drainMs: 50 })
    await rm(dir, { recursive: true, force: true })
  }
})

test("streaming HTTP/1.1 and HTTP/2 request bodies deliver chunks before upload finishes", async () => {
  let releaseSecondChunk: (() => void) | undefined
  let firstChunkArrived = new Promise<void>((resolve) => {
    releaseSecondChunk = resolve
  })
  const app = server()
    .post("/stream", async (c) => {
      const stream = c.req.body
      assert.ok(stream !== null)
      const reader = stream.getReader()
      const first = await reader.read()
      assert.equal(first.done, false)
      const firstText = new TextDecoder().decode(first.value)
      releaseSecondChunk?.()
      const rest: Uint8Array[] = []
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        rest.push(next.value)
      }
      return { first: firstText, rest: Buffer.concat(rest).toString("utf8") }
    })
    .post("/json-stream", async (c) => ({ parsed: await c.req.json() }))
  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    http2: true,
    engine: { streamRequestBodies: true },
  })
  try {
    // HTTP/1.1 chunked upload pausing between chunk 1 arrival in handler and chunk 2
    const h1Body = await new Promise<string>((resolve, reject) => {
      const sock = createConnection({ port: running.port, host: "127.0.0.1" }, () => {
        sock.write(
          "POST /stream HTTP/1.1\r\nHost: x\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n5\r\nhello\r\n",
        )
        void firstChunkArrived.then(() => {
          sock.write("6\r\n-world\r\n0\r\n\r\n")
        })
      })
      const chunks: Buffer[] = []
      sock.on("data", (c) => chunks.push(c))
      sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      sock.on("error", reject)
    })
    assert.match(h1Body, /"first":"hello"/)
    assert.match(h1Body, /"rest":"-world"/)

    // Reset barrier for HTTP/2 streaming upload
    firstChunkArrived = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve
    })
    const h2 = http2Connect(`http://127.0.0.1:${running.port}`)
    const h2Body = await new Promise<string>((resolve, reject) => {
      const req = h2.request({ ":method": "POST", ":path": "/stream" })
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      req.on("error", reject)
      req.write("part1-")
      void firstChunkArrived.then(() => req.end("part2"))
    })
    h2.close()
    assert.deepEqual(JSON.parse(h2Body), { first: "part1-", rest: "part2" })

    const jsonRes = await fetch(`http://127.0.0.1:${running.port}/json-stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streamed: true }),
    })
    assert.equal(jsonRes.status, 200)
    assert.deepEqual(await jsonRes.json(), { parsed: { streamed: true } })
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("route deflate: false overrides global wsDeflate: true", async () => {
  const app = server()
    .use(websocket())
    .ws("/no-deflate", {
      deflate: false,
      message(ws, data) {
        ws.send(data)
      },
    })
    .ws("/with-deflate", {
      message(ws, data) {
        ws.send(data)
      },
    })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1", wsDeflate: true })
  try {
    const offClient = new WsClient(`ws://127.0.0.1:${running.port}/no-deflate`, {
      perMessageDeflate: true,
    })
    let offExt = ""
    offClient.on("upgrade", (res) => {
      offExt = String(res.headers["sec-websocket-extensions"] ?? "")
    })
    await new Promise<void>((r) => offClient.once("open", () => r()))
    assert.equal(offExt, "")
    offClient.close()

    const onClient = new WsClient(`ws://127.0.0.1:${running.port}/with-deflate`, {
      perMessageDeflate: true,
    })
    let onExt = ""
    onClient.on("upgrade", (res) => {
      onExt = String(res.headers["sec-websocket-extensions"] ?? "")
    })
    await new Promise<void>((r) => onClient.once("open", () => r()))
    assert.match(onExt, /permessage-deflate/)
    onClient.close()
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("WebSocket peer close reason, native bufferedAmount, per-route deflate, and RFC 8441 H2 WS", async () => {
  let closeObserved: { code: number; reason: string; buffered: number } | undefined
  const app = server()
    .use(websocket())
    .ws("/plain", {
      open(ws) {
        closeObserved = { code: 0, reason: "", buffered: ws.getBufferedAmount?.() ?? -1 }
      },
      message(ws, data) {
        ws.cork?.(() => {
          ws.send(data)
          ws.send("after")
        })
      },
      close(_ws, code, reason) {
        if (closeObserved !== undefined) closeObserved = { ...closeObserved, code, reason }
      },
    })
    .ws("/compressed", {
      deflate: true,
      message(ws, data) {
        ws.send(data)
      },
    })
  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    http2: true,
    engine: { wsMaxBackpressure: 1024, wsCloseOnBackpressureLimit: true },
  })
  try {
    // 1. Peer close reason + bufferedAmount
    const client = new WsClient(`ws://127.0.0.1:${running.port}/plain`, {
      perMessageDeflate: false,
    })
    await new Promise<void>((r) => client.once("open", () => r()))
    client.close(4002, "bye-from-peer")
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(closeObserved?.buffered, 0)
    assert.equal(closeObserved?.code, 4002)
    assert.equal(closeObserved?.reason, "bye-from-peer")

    // 2. Per-route permessage-deflate negotiation
    const deflated = new WsClient(`ws://127.0.0.1:${running.port}/compressed`, {
      perMessageDeflate: true,
    })
    let negotiatedExt = ""
    deflated.on("upgrade", (res) => {
      negotiatedExt = String(res.headers["sec-websocket-extensions"] ?? "")
    })
    await new Promise<void>((r) => deflated.once("open", () => r()))
    assert.match(negotiatedExt, /permessage-deflate/)
    const echoed = new Promise<string>((r) => deflated.once("message", (d) => r(d.toString())))
    deflated.send("compressed-hello")
    assert.equal(await echoed, "compressed-hello")
    deflated.close()

    // 3. RFC 8441 Extended CONNECT WebSocket over HTTP/2
    const h2 = http2Connect(`http://127.0.0.1:${running.port}`)
    await new Promise<void>((resolve, reject) => {
      h2.once("remoteSettings", (settings) => {
        assert.equal(settings.enableConnectProtocol, true)
        resolve()
      })
      h2.once("error", reject)
    })
    const payload = "hello-h2-ws".repeat(120)
    const h2Echo = await new Promise<string[]>((resolve, reject) => {
      const stream = h2.request({
        ":method": "CONNECT",
        ":protocol": "websocket",
        ":path": "/plain",
      })
      stream.on("error", reject)
      stream.once("close", () => reject(new Error("HTTP/2 WebSocket closed before both messages")))
      stream.once("response", (headers) => {
        assert.equal(headers[":status"], 200)
        stream.write(encodeClientWsFrame(0x1, Buffer.from(payload)))
      })
      const received: string[] = []
      let acc = Buffer.alloc(0)
      stream.on("data", (chunk: Buffer) => {
        acc = Buffer.concat([acc, chunk])
        for (
          let frame = decodeServerWsFrame(acc);
          frame !== null;
          frame = decodeServerWsFrame(acc)
        ) {
          acc = acc.subarray(frame.consumed)
          if (frame.opcode === 0x1) received.push(frame.payload.toString("utf8"))
          if (received.length === 2) {
            stream.end(encodeClientWsFrame(0x8, Buffer.from([0x03, 0xe8])))
            resolve(received)
            break
          }
        }
      })
    })
    h2.close()
    assert.deepEqual(h2Echo, [payload, "after"])
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("WebSocket wsMaxBackpressure + wsCloseOnBackpressureLimit closes stalled sockets", async () => {
  const closedCodes: number[] = []
  const app = server()
    .use(websocket())
    .ws("/flood", {
      open(ws) {
        const big = Buffer.alloc(128 * 1024, 0x61)
        for (let i = 0; i < 64; i++) {
          if (ws.readyState !== 1) break
          ws.send(big)
        }
      },
      close(_ws, code) {
        closedCodes.push(code)
      },
    })
  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    engine: {
      wsMaxBackpressure: 1024,
      wsCloseOnBackpressureLimit: true,
    },
  })
  try {
    const client = new WsClient(`ws://127.0.0.1:${running.port}/flood`)
    client.on("error", () => {})
    await new Promise<void>((resolve) => {
      client.once("open", () => client.pause())
      client.once("close", () => resolve())
      setTimeout(resolve, 1000)
    })
    assert.ok(closedCodes.length >= 1)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("releasing an unconsumed streaming request body terminates detached readers", async () => {
  let pipeResult: Promise<void> | undefined
  const app = server().post("/early-return", (c) => {
    const body = c.req.body
    assert.ok(body !== null)
    pipeResult = body.pipeTo(new WritableStream())
    // Attach a no-op rejection handler in the handler turn because `release()` runs before the client receives the TCP response.
    void pipeResult.catch(() => {})
    return { ok: true }
  })
  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    engine: { streamRequestBodies: true },
  })
  const sock = createConnection({ port: running.port, host: "127.0.0.1" }, () => {
    // Send only the first chunk and keep the TCP connection open until pipeTo rejects.
    sock.write(
      "POST /early-return HTTP/1.1\r\nHost: x\r\ntransfer-encoding: chunked\r\nconnection: keep-alive\r\n\r\n5\r\nhello\r\n",
    )
  })
  try {
    await new Promise<void>((resolve, reject) => {
      let buf = ""
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8")
        if (buf.includes('"ok":true')) resolve()
      })
      sock.on("error", reject)
    })
    assert.ok(pipeResult !== undefined)
    await assert.rejects(pipeResult, /released/i)
  } finally {
    sock.destroy()
    await running.stop({ drainMs: 50 })
  }
})

test("native zstd compression negotiates and compresses payloads", async (t) => {
  if (typeof zlib.zstdDecompressSync !== "function") {
    t.skip("Node < 22.15 does not provide zlib.zstdDecompressSync")
    return
  }
  const big = "zstd-compressible-payload-".repeat(120)
  const app = server().get("/zstd", () => ({ text: big }))
  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    compression: { zstd: true, brotli: false, gzip: false, deflate: false, minBytes: 128 },
  })
  try {
    const res = await new Promise<{ ce: string | undefined; raw: Buffer }>((resolve, reject) => {
      const req = httpRequest(
        {
          port: running.port,
          hostname: "127.0.0.1",
          path: "/zstd",
          headers: { "accept-encoding": "zstd" },
        },
        (r) => {
          const chunks: Buffer[] = []
          r.on("data", (c) => chunks.push(c))
          r.on("end", () =>
            resolve({
              ce:
                typeof r.headers["content-encoding"] === "string"
                  ? r.headers["content-encoding"]
                  : undefined,
              raw: Buffer.concat(chunks),
            }),
          )
        },
      )
      req.on("error", reject)
      req.end()
    })
    assert.equal(res.ce, "zstd")
    assert.equal(zlib.zstdDecompressSync(res.raw).toString("utf8").includes(big), true)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("HTTP/1.1 chunked and HTTP/2 request trailers are exposed via platform.trailers", async () => {
  const handler = {
    async fetch(req: Request, platform?: { readonly trailers?: Record<string, string> }) {
      const text = await req.text()
      return Response.json({ text, trailers: platform?.trailers ?? {} })
    },
  }
  const running = await serve(handler, { port: 0, hostname: "127.0.0.1", http2: true })
  try {
    const h1Wire = await new Promise<string>((resolve, reject) => {
      const sock = createConnection({ port: running.port, host: "127.0.0.1" }, () => {
        sock.write(
          "POST /trail HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n0\r\nX-Checksum: abc123\r\n\r\n",
        )
      })
      const chunks: Buffer[] = []
      sock.on("data", (c) => chunks.push(c))
      sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      sock.on("error", reject)
    })
    const h1Json = JSON.parse(h1Wire.slice(h1Wire.indexOf("\r\n\r\n") + 4))
    assert.deepEqual(h1Json, { text: "hello", trailers: { "x-checksum": "abc123" } })

    const h2 = http2Connect(`http://127.0.0.1:${running.port}`)
    try {
      const h2Body = await new Promise<string>((resolve, reject) => {
        const stream = h2.request(
          { ":method": "POST", ":path": "/trail", trailer: "x-digest" },
          { waitForTrailers: true },
        )
        stream.on("wantTrailers", () => {
          stream.sendTrailers({ "x-digest": "sha256=ok" })
        })
        const chunks: Buffer[] = []
        stream.on("data", (c) => chunks.push(c))
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
        stream.on("error", reject)
        stream.end("payload")
      })
      assert.deepEqual(JSON.parse(h2Body), {
        text: "payload",
        trailers: { "x-digest": "sha256=ok" },
      })
    } finally {
      h2.close()
    }
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("ws.cork batches direct sends and native publish without triggering backpressure", async () => {
  const payload = "a".repeat(1200)
  const app = server()
    .use(websocket())
    .ws("/cork", {
      open: (ws) => ws.subscribe("cork"),
      message(ws) {
        assert.equal(typeof ws.cork, "function")
        ws.cork?.(() => {
          ws.send(`${payload}-1`)
          app.publish("cork", `${payload}-2`)
          ws.send(`${payload}-3`)
        })
      },
    })
  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    engine: { wsMaxBackpressure: 1024, wsCloseOnBackpressureLimit: true },
  })
  try {
    const received = await new Promise<string[]>((resolve, reject) => {
      const out: string[] = []
      const client = new WsClient(`ws://127.0.0.1:${running.port}/cork`)
      client.once("open", () => client.send("hi"))
      client.on("message", (d) => {
        out.push(d.toString())
        if (out.length === 3) {
          client.close()
          resolve(out)
        }
      })
      client.once("error", reject)
      client.once("close", () => reject(new Error("WebSocket closed before all corked messages")))
    })
    assert.deepEqual(received, [`${payload}-1`, `${payload}-2`, `${payload}-3`])
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("corked TLS writes flush when TLS framing exceeds the write buffer limit", async () => {
  const payload = "a".repeat(4096)
  const tls = await selfSignedCertificate()
  const app = server()
    .use(websocket())
    .ws("/cork", {
      open(ws) {
        queueMicrotask(() => ws.cork?.(() => ws.send(payload)))
      },
    })
  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    tls,
    engine: { responseBackpressureLimit: payload.length + 4 },
  })
  const client = new WsClient(`wss://127.0.0.1:${running.port}/cork`, { ca: tls.cert })
  try {
    const received = await new Promise<string>((resolve, reject) => {
      client.once("message", (data) => resolve(data.toString()))
      client.once("error", reject)
      client.once("close", () =>
        reject(new Error("TLS WebSocket closed before the corked message")),
      )
    })
    assert.equal(received, payload)
  } finally {
    client.close()
    await running.stop({ drainMs: 50 })
  }
})

test("serve reports the bound TCP port of an inherited listener", {
  skip: process.platform === "win32",
}, async () => {
  const bound = bindSharedListenerSocket(0, "127.0.0.1", undefined)
  assert.ok(bound)
  const running = await serve(
    server().get("/", () => ({ ok: true })),
    {
      engine: { listenerFd: bound.fd },
    },
  ).finally(() => closeSync(bound.fd))
  try {
    assert.equal(running.port, bound.port)
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${running.port}`)).json(), { ok: true })
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("probe(), isNativeAvailable(), and graceful fallback: true to @nifrajs/node", async () => {
  const info = probe()
  assert.equal(info.ok, true)
  assert.equal(isNativeAvailable(), true)
  assert.equal(info.capabilities.http2, true)
  assert.equal(info.capabilities.websocket, true)

  const app = server().get("/fb", () => ({ fallback: true }))
  const prev = process.env.NIFRA_RUST_ENGINE_PATH
  process.env.NIFRA_RUST_ENGINE_PATH = "/nonexistent-nifra-addon-for-fallback-test.node"
  try {
    assert.equal(isNativeAvailable(), false)
    assert.equal(probe().ok, false)
    assert.throws(() => serve(app, { port: 0, hostname: "127.0.0.1" }), TypeError)

    const running = await serve(app, { port: 0, hostname: "127.0.0.1", fallback: true })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/fb`)
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { fallback: true })
      assert.throws(() => running.reloadTls(), /fallback/)
    } finally {
      await running.stop({ drainMs: 50 })
    }
    await assert.rejects(
      () => serve(app, { port: 0, fallback: true, maxBodySize: 1024 }),
      /maxBodySize/,
    )
    await assert.rejects(
      () => serve(app, { port: 0, fallback: true, oversizeWindow: 1024 }),
      /oversizeWindow/,
    )
    await assert.rejects(
      () => serve(app, { port: 0, fallback: true, wsMaxMessageSize: 1024 }),
      /wsMaxMessageSize/,
    )
    await assert.rejects(
      () => serve(app, { port: 0, fallback: true, engine: { listenerFd: 0 } }),
      /listenerFd/,
    )
  } finally {
    if (prev === undefined) delete process.env.NIFRA_RUST_ENGINE_PATH
    else process.env.NIFRA_RUST_ENGINE_PATH = prev
  }
  assert.equal(isNativeAvailable(), true)
})

test("streaming request trailers are not stale-cached before end and resist prototype keys", async () => {
  const handler = {
    async fetch(req: Request, platform?: { readonly trailers?: Record<string, string> }) {
      const before = { ...(platform?.trailers ?? {}) }
      const text = await req.text()
      const after = platform?.trailers ?? {}
      return Response.json({
        before,
        text,
        digest: after["x-digest"],
        ctor: Object.getOwnPropertyDescriptor(after, "constructor")?.value,
      })
    },
  }
  const running = await serve(handler, {
    port: 0,
    hostname: "127.0.0.1",
    engine: { streamRequestBodies: true },
  })
  try {
    const wire = await new Promise<string>((resolve, reject) => {
      const sock = createConnection({ port: running.port, host: "127.0.0.1" }, () => {
        sock.write(
          "POST /stream-trail HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nfirst\r\n",
        )
        setTimeout(() => {
          sock.write("0\r\nx-digest: late123\r\nconstructor: safeval\r\n\r\n")
        }, 30)
      })
      const chunks: Buffer[] = []
      sock.on("data", (c) => chunks.push(c))
      sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      sock.on("error", reject)
    })
    const json = JSON.parse(wire.slice(wire.indexOf("\r\n\r\n") + 4))
    assert.deepEqual(json, {
      before: {},
      text: "first",
      digest: "late123",
      ctor: "safeval",
    })
  } finally {
    await running.stop({ drainMs: 50 })
  }
})
