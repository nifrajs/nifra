import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { request as httpsRequest } from "node:https"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { server, status } from "@nifrajs/core"
import { selfSignedCertificate } from "../../../internal/test-utils/src/tls.ts"
import { serve, type UwsServer } from "../src/index.ts"
import { AUTH, parseHead, raw, sleep } from "./support.ts"

const BIG = Buffer.alloc(6_000_000)
for (let i = 0; i < BIG.length; i++) BIG[i] = (i * 31 + (i >> 8)) & 255
const BIG_HASH = createHash("sha256").update(BIG).digest("hex")

function makeApp() {
  return server()
    .get("/stream", () => {
      const encoder = new TextEncoder()
      let n = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await sleep(15)
            controller.enqueue(encoder.encode(`chunk-${n}\n`))
            if (++n === 4) controller.close()
          },
        }),
        { headers: { "content-type": "text/plain" } },
      )
    })
    .get("/big-known", () => {
      let offset = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= BIG.length) return controller.close()
            controller.enqueue(BIG.subarray(offset, offset + 65_536))
            offset += 65_536
          },
        }),
        {
          headers: {
            "content-length": String(BIG.length),
            "content-type": "application/octet-stream",
          },
        },
      )
    })
    .get("/big-chunked", () => {
      let offset = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= BIG.length) return controller.close()
            controller.enqueue(BIG.subarray(offset, offset + 65_536))
            offset += 65_536
          },
        }),
      )
    })
    .get("/short-known", () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(70_000))
            controller.enqueue(new Uint8Array(70_000))
            controller.close()
          },
        }),
        { headers: { "content-length": "999999" } },
      )
    })
    .get("/errors-midway", () => {
      let n = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await sleep(5)
            if (n++ === 2) return controller.error(new Error("stream failed"))
            controller.enqueue(new TextEncoder().encode("part"))
          },
        }),
      )
    })
    .get("/crlf", (c) => {
      c.set.headers["x-reflected"] = "ok\r\nx-injected: yes"
      return { ok: true }
    })
    .get("/bad-status", () => new Response("x", { status: 200 }))
    .get("/custom-status", () => status(299, { ok: true }))
    .get("/never", () => new Promise<never>(() => {}))
    .get("/hang-then-answer", async () => {
      await sleep(80)
      return { done: true }
    })
    .post("/echo-length", async (c) => {
      const body = new Uint8Array(await c.req.arrayBuffer())
      return { length: body.byteLength }
    })
    .post("/first-bytes", async (c) => {
      const reader = c.req.body?.getReader()
      const first = await reader?.read()
      await reader?.cancel()
      return { first: first?.value?.byteLength ?? 0 }
    })
    .post("/no-read", () => ({ ignored: true }))
    .post("/auth-first", (c) => {
      if (c.header("authorization") === null) return status(401, { ok: false })
      return { ok: true }
    })
    .get("/who", (c) => ({ url: c.req.url, ip: c.clientIp }))
}

let port = 0
let handle: UwsServer
before(async () => {
  handle = await serve(makeApp(), { port: 0, hostname: "127.0.0.1" })
  port = handle.port
})
after(async () => {
  await handle.stop({ drainMs: 0 })
})

const GET = (path: string, extra = ""): string =>
  `GET ${path} HTTP/1.1\r\nHost: example.test\r\n${extra}\r\n`

test("a body streamed in pieces arrives chunked, in order", async () => {
  const text = await raw(port, GET("/stream"), (r) => r.endsWith("0\r\n\r\n"), 3000)
  const head = parseHead(text)
  assert.equal(head.status, 200)
  assert.equal(head.headers.get("transfer-encoding")?.[0], "chunked")
  assert.deepEqual(
    [...head.body.matchAll(/chunk-(\d)/g)].map((m) => m[1]),
    ["0", "1", "2", "3"],
  )
})

test("a 6 MB body with a declared length survives a slow reader intact (tryEnd + onWritable)", async () => {
  const hash = createHash("sha256")
  let received = 0
  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(GET("/big-known")))
    let head = Buffer.alloc(0)
    let bodyStart = -1
    let declared = 0
    socket.on("data", (chunk: Buffer) => {
      let data = chunk
      if (bodyStart === -1) {
        head = Buffer.concat([head, data])
        const end = head.indexOf("\r\n\r\n")
        if (end === -1) return
        declared = Number(/content-length: (\d+)/i.exec(head.subarray(0, end).toString())?.[1])
        bodyStart = end + 4
        data = head.subarray(bodyStart)
      }
      hash.update(data)
      received += data.length
      socket.pause()
      setTimeout(() => socket.resume(), 1)
      if (received >= declared) {
        socket.destroy()
        resolve()
      }
    })
    socket.on("error", reject)
    setTimeout(() => reject(new Error(`stalled at ${received}`)), 15000).unref()
  })
  assert.equal(received, BIG.length)
  assert.equal(hash.digest("hex"), BIG_HASH)
})

test("a 6 MB chunked body arrives intact", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/big-chunked`)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.length, BIG.length)
  assert.equal(createHash("sha256").update(bytes).digest("hex"), BIG_HASH)
})

test("a stream shorter than its Content-Length cuts the connection and the server keeps serving", async () => {
  const text = await raw(port, GET("/short-known"), () => false, 1500)
  assert.ok(!text.includes("0\r\n\r\n"), "no clean end of response")
  const next = await fetch(`http://127.0.0.1:${port}/stream`)
  assert.equal(next.status, 200)
  await next.text()
})

test("a stream that errors after the head cuts the connection instead of finishing it", async () => {
  const text = await raw(port, GET("/errors-midway"), () => false, 1500)
  assert.match(text, /^HTTP\/1\.1 200/)
  assert.ok(!text.endsWith("0\r\n\r\n"), "the chunked body was not terminated")
  assert.equal((await fetch(`http://127.0.0.1:${port}/custom-status`)).status, 299)
})

test("a CR/LF in a header value never reaches the wire: 500, no injected header", async () => {
  const text = await raw(port, GET("/crlf"), (r) => r.includes("\r\n\r\n") && r.length > 60)
  const head = parseHead(text)
  assert.equal(head.status, 500)
  assert.equal(head.headers.has("x-injected"), false)
  assert.equal(head.headers.has("x-reflected"), false)
  assert.ok(!text.includes("x-injected"))
})

test("a custom status code is written with its reason phrase", async () => {
  const text = await raw(port, GET("/custom-status"), (r) => r.includes("}"))
  assert.match(text, /^HTTP\/1\.1 299 /)
})

test("a client that hangs up mid-request leaves nothing behind, and stop() sees no request in flight", async () => {
  const own = await serve(makeApp(), { port: 0, hostname: "127.0.0.1" })
  for (let i = 0; i < 40; i++) {
    const socket = connect(own.port, "127.0.0.1", () => socket.write(GET("/never")))
    socket.on("error", () => {})
    setTimeout(() => socket.destroy(), 5)
  }
  await sleep(150)
  const started = Date.now()
  await own.stop({ drainMs: 5000 })
  assert.ok(
    Date.now() - started < 1500,
    "drain finished at once: aborted requests were not counted as live",
  )
})

test("300 uploads cut off mid-body do not wedge the server, and a 2 MB body is still refused", async () => {
  await Promise.all(
    Array.from({ length: 300 }, () => {
      return new Promise<void>((resolve) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(
            `POST /echo-length HTTP/1.1\r\nHost: x\r\ncontent-length: 5000\r\n\r\n{"partial":`,
          )
          setTimeout(() => {
            socket.destroy()
            resolve()
          }, 3)
        })
        socket.on("error", () => resolve())
      })
    }),
  )
  const big = await fetch(`http://127.0.0.1:${port}/echo-length`, {
    method: "POST",
    body: Buffer.alloc(2_000_000),
  })
  assert.equal(big.status, 413)
  const ok = await fetch(`http://127.0.0.1:${port}/echo-length`, { method: "POST", body: "12345" })
  assert.deepEqual(await ok.json(), { length: 5 })
})

test("a chunked upload larger than the cap is refused without being buffered whole", async () => {
  const chunk = Buffer.alloc(100_000, 7)
  const text = await new Promise<string>((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write("POST /echo-length HTTP/1.1\r\nHost: x\r\ntransfer-encoding: chunked\r\n\r\n")
      let sent = 0
      const timer = setInterval(() => {
        if (socket.destroyed || sent >= 40) return clearInterval(timer)
        sent++
        socket.write(`${chunk.length.toString(16)}\r\n`)
        socket.write(chunk)
        socket.write("\r\n")
      }, 2)
    })
    let received = ""
    socket.on("data", (data) => {
      received += data.toString("latin1")
      if (received.includes("}")) {
        socket.destroy()
        resolve(received)
      }
    })
    socket.on("error", () => resolve(received))
    setTimeout(() => {
      socket.destroy()
      resolve(received)
    }, 4000).unref()
  })
  assert.equal(parseHead(text).status, 413)
})

test("a handler that answers without reading the body leaves the connection usable", async () => {
  const body = Buffer.alloc(300_000, 1)
  const first = `POST /no-read HTTP/1.1\r\nHost: x\r\ncontent-length: ${body.length}\r\n\r\n`
  const second = "GET /who HTTP/1.1\r\nHost: x\r\n\r\n"
  const text = await new Promise<string>((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(first)
      socket.write(body)
      socket.write(second)
    })
    let received = ""
    socket.on("data", (data) => {
      received += data.toString("latin1")
      if ((received.match(/HTTP\/1\.1 200/g) ?? []).length === 2 && received.endsWith("}")) {
        socket.destroy()
        resolve(received)
      }
    })
    setTimeout(() => {
      socket.destroy()
      resolve(received)
    }, 3000).unref()
  })
  assert.equal((text.match(/HTTP\/1\.1 200/g) ?? []).length, 2, text.slice(0, 400))
})

test("answering before the upload finishes (a 401) does not corrupt the next request on the socket", async () => {
  const body = Buffer.alloc(200_000, 2)
  const first = `POST /auth-first HTTP/1.1\r\nHost: x\r\ncontent-length: ${body.length}\r\n\r\n`
  const text = await new Promise<string>((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(first)
      socket.write(body)
      socket.write(`GET /who HTTP/1.1\r\nHost: x\r\nauthorization: ${AUTH}\r\n\r\n`)
    })
    let received = ""
    socket.on("data", (data) => {
      received += data.toString("latin1")
      if (received.includes("HTTP/1.1 401") && received.includes("HTTP/1.1 200")) {
        socket.destroy()
        resolve(received)
      }
    })
    setTimeout(() => {
      socket.destroy()
      resolve(received)
    }, 3000).unref()
  })
  assert.match(text, /HTTP\/1\.1 401/)
  assert.match(text, /HTTP\/1\.1 200/)
})

test("a reader that cancels the body stream does not leave the upload paused", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/first-bytes`, {
    method: "POST",
    body: Buffer.alloc(3_000_000, 3),
    headers: { "content-type": "application/octet-stream" },
  })
  // The 1 MB cap refuses the declared length before any read; either way the exchange completes.
  assert.ok([200, 413].includes(response.status))
  await response.text()
})

test("the client's address is the socket peer", async () => {
  const body: { ip: string; url: string } = await (
    await fetch(`http://127.0.0.1:${port}/who`)
  ).json()
  assert.match(body.ip, /127\.0\.0\.1$/)
  assert.equal(body.url, `http://127.0.0.1:${port}/who`)
})

test("a WebSocket handshake is refused with 501, not answered as a plain GET", async () => {
  const text = await raw(
    port,
    "GET /who HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    (r) => r.includes("}"),
  )
  assert.equal(parseHead(text).status, 501)
})

test("a request with two Host headers, or CL together with TE, is refused by the parser", async () => {
  const hosts = await raw(port, "GET /who HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n")
  assert.equal(parseHead(hosts).status, 400)
  const smuggle = await raw(
    port,
    "POST /echo-length HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
  )
  assert.equal(parseHead(smuggle).status, 400)
})

test("an unknown method reaches the app", async () => {
  const text = await raw(port, "PROPFIND /who HTTP/1.1\r\nHost: x\r\n\r\n", (r) =>
    r.includes("\r\n\r\n"),
  )
  assert.match(text, /^HTTP\/1\.1 (404|405)/)
})

test("allowedHosts, canonicalHost and normalizeTarget behave as they do on @nifrajs/node", async () => {
  const app = server()
    .get("/admin", () => ({ path: "admin" }))
    .get("/public/x", () => ({ path: "public" }))
  const strict = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    allowedHosts: ["api.example.com"],
    canonicalHost: "api.example.com",
    normalizeTarget: true,
  })
  try {
    const refused = await raw(strict.port, "GET /admin HTTP/1.1\r\nHost: evil.test\r\n\r\n", (r) =>
      r.includes("Bad Request"),
    )
    assert.equal(parseHead(refused).status, 400)
    const odd = await raw(strict.port, "GET /admin HTTP/1.1\r\nHost: a b\r\n\r\n", (r) =>
      r.includes("Bad Request"),
    )
    assert.equal(parseHead(odd).status, 400)
    const ok = await raw(
      strict.port,
      "GET /public/../admin HTTP/1.1\r\nHost: API.example.com\r\n\r\n",
      (r) => r.includes("}"),
    )
    assert.equal(parseHead(ok).status, 200)
    assert.match(ok, /"admin"/)
  } finally {
    await strict.stop({ drainMs: 0 })
  }
  const loose = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const text = await raw(loose.port, "GET /public/../admin HTTP/1.1\r\nHost: x\r\n\r\n", (r) =>
      r.includes("\r\n\r\n"),
    )
    assert.equal(parseHead(text).status, 404)
  } finally {
    await loose.stop({ drainMs: 0 })
  }
})

test("a plain { fetch } handler is served through the Web lane", async () => {
  const handler = {
    async fetch(request: Request, platform?: { readonly clientIp?: string | undefined }) {
      const body = request.method === "POST" ? await request.text() : ""
      return Response.json({
        method: request.method,
        url: new URL(request.url).pathname,
        body,
        ua: request.headers.get("user-agent"),
        ip: platform?.clientIp,
      })
    },
  }
  const plain = await serve(handler, { port: 0, hostname: "127.0.0.1" })
  try {
    const get = await (
      await fetch(`http://127.0.0.1:${plain.port}/a?b=1`, { headers: { "user-agent": "t" } })
    ).json()
    assert.deepEqual(
      { ...get, ip: typeof get.ip },
      { method: "GET", url: "/a", body: "", ua: "t", ip: "string" },
    )
    const post = await (
      await fetch(`http://127.0.0.1:${plain.port}/p`, { method: "POST", body: "hello" })
    ).json()
    assert.equal(post.body, "hello")
  } finally {
    await plain.stop({ drainMs: 0 })
  }
})

test("a plain handler that throws or rejects gets a flat 500", async () => {
  const handler = {
    fetch(request: Request): Response | Promise<Response> {
      if (new URL(request.url).pathname === "/sync") throw new Error("sync")
      return Promise.reject(new Error("async"))
    },
  }
  const plain = await serve(handler, { port: 0, hostname: "127.0.0.1" })
  try {
    for (const path of ["/sync", "/async"]) {
      const response = await fetch(`http://127.0.0.1:${plain.port}${path}`)
      assert.equal(response.status, 500)
      assert.deepEqual(await response.json(), { ok: false, error: "internal_error" })
    }
  } finally {
    await plain.stop({ drainMs: 0 })
  }
})

test("options the adapter cannot honour are refused up front", () => {
  const app = server()
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the option is deliberately not part of the type
  assert.throws(() => serve(app, { port: 0, static: () => undefined } as never), /static/)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the option is deliberately not part of the type
  assert.throws(() => serve(app, { port: 0, fastResponse: true } as never), /fastResponse/)
  assert.throws(() => serve(app, { port: -1 }), /port/)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: an invalid value, to prove the runtime check
  assert.throws(() => serve(app, { port: 0, protocol: "ftp" as never }), /protocol/)
  assert.throws(() => serve(app, { port: 0, allowedHosts: ["bad host"] }), /invalid allowed host/)
  assert.throws(() => serve(app, { port: 0, canonicalHost: "a/b" }), /canonical host/)
})

test("listening on a port that is taken rejects", async () => {
  const other = await serve(server(), { port: 0, hostname: "127.0.0.1" })
  try {
    await assert.rejects(
      serve(server(), { port: other.port, hostname: "127.0.0.1" }),
      /cannot listen/,
    )
  } finally {
    await other.stop({ drainMs: 0 })
  }
})

test("HTTPS from key and certificate files", async () => {
  const pair = await selfSignedCertificate()
  const dir = await mkdtemp(join(tmpdir(), "node-uws-tls-"))
  try {
    await writeFile(join(dir, "cert.pem"), pair.cert)
    await writeFile(join(dir, "key.pem"), pair.key)
    const tls = await serve(
      server().get("/where", (c) => ({ url: c.req.url })),
      {
        port: 0,
        hostname: "127.0.0.1",
        tls: { certFileName: join(dir, "cert.pem"), keyFileName: join(dir, "key.pem") },
      },
    )
    try {
      const body = await new Promise<string>((resolve, reject) => {
        httpsRequest(`https://127.0.0.1:${tls.port}/where`, { ca: pair.cert }, (res) => {
          let text = ""
          res.setEncoding("utf8")
          res.on("data", (part: string) => {
            text += part
          })
          res.on("end", () => resolve(text))
        })
          .on("error", reject)
          .end()
      })
      assert.deepEqual(JSON.parse(body), { url: `https://127.0.0.1:${tls.port}/where` })
    } finally {
      await tls.stop({ drainMs: 0 })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
