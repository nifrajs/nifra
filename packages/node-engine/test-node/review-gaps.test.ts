import assert from "node:assert/strict"
import { AsyncLocalStorage } from "node:async_hooks"
import { execFile } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import diagnosticsChannel from "node:diagnostics_channel"
import http, { IncomingMessage, ServerResponse } from "node:http"
import http2 from "node:http2"
import { connect as netConnect } from "node:net"
import test from "node:test"
import tls from "node:tls"
import { promisify } from "node:util"
import { server } from "../../core/dist/index.js"
import {
  fromNodeHandler,
  fromNodeMiddleware,
  getPeerCertificate,
  serve,
  writeEarlyHints,
  writeInformational,
} from "../dist/index.js"

const execFileAsync = promisify(execFile)

// Minimal self-contained DER helpers so mTLS tests generate real X.509 CA + signed client/server certs.
function lenBytes(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len])
  const bytes: number[] = []
  let n = len
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes])
}
function der(tag: number, ...parts: readonly Uint8Array[]): Uint8Array {
  const body = Buffer.concat(parts)
  return Buffer.concat([new Uint8Array([tag]), lenBytes(body.byteLength), body])
}
const seq = (...p: readonly Uint8Array[]) => der(0x30, ...p)
const set = (...p: readonly Uint8Array[]) => der(0x31, ...p)
const derInt = (b: Uint8Array) =>
  der(0x02, b.length > 0 && (b[0] ?? 0) >= 0x80 ? Buffer.concat([new Uint8Array([0]), b]) : b)
const oid = (dotted: string) => {
  const n = dotted.split(".").map(Number)
  const out = [(n[0] ?? 0) * 40 + (n[1] ?? 0)]
  for (const v of n.slice(2)) {
    const g: number[] = []
    let x = v
    do {
      g.unshift(x & 0x7f)
      x >>>= 7
    } while (x > 0)
    for (let i = 0; i < g.length - 1; i++) g[i] = (g[i] ?? 0) | 0x80
    out.push(...g)
  }
  return der(0x06, new Uint8Array(out))
}
const utf8 = (s: string) => der(0x0c, Buffer.from(s))
const bitString = (b: Uint8Array) => der(0x03, Buffer.concat([new Uint8Array([0]), b]))
const utcTime = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0")
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  return der(0x17, Buffer.from(s, "ascii"))
}
const x509Name = (cn: string) => seq(set(seq(oid("2.5.4.3"), utf8(cn))))
const pem = (label: string, body: Uint8Array) =>
  `-----BEGIN ${label}-----\n${(
    Buffer.from(body)
      .toString("base64")
      .match(/.{1,64}/g) ?? []
  ).join("\n")}\n-----END ${label}-----\n`

async function signTbs(tbs: Uint8Array, privateKeyPem: string): Promise<Uint8Array> {
  const { sign } = await import("node:crypto")
  const sigAlg = seq(oid("1.2.840.10045.4.3.2"))
  return seq(tbs, sigAlg, bitString(sign("sha256", Buffer.from(tbs), privateKeyPem)))
}

async function generateMtlsBundle() {
  const caKeys = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  const now = Date.now()
  const day = 86_400_000
  const sigAlg = seq(oid("1.2.840.10045.4.3.2"))
  const bc = seq(
    oid("2.5.29.19"),
    der(0x01, new Uint8Array([0xff])),
    der(0x04, seq(der(0x01, new Uint8Array([0xff])))),
  )
  const ku = seq(
    oid("2.5.29.15"),
    der(0x01, new Uint8Array([0xff])),
    der(0x04, bitString(new Uint8Array([0x06]))),
  )
  const caTbs = seq(
    der(0xa0, derInt(new Uint8Array([2]))),
    derInt(new Uint8Array([1])),
    sigAlg,
    x509Name("Test Root CA"),
    seq(utcTime(new Date(now - day)), utcTime(new Date(now + 30 * day))),
    x509Name("Test Root CA"),
    caKeys.publicKey,
    der(0xa3, seq(bc, ku)),
  )
  const caCert = pem("CERTIFICATE", await signTbs(caTbs, caKeys.privateKey))

  const issue = async (cn: string, serial: number, clientAuth: boolean) => {
    const kp = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    })
    const san = seq(
      oid("2.5.29.17"),
      der(
        0x04,
        seq(der(0x82, Buffer.from("localhost")), der(0x87, new Uint8Array([127, 0, 0, 1]))),
      ),
    )
    const eku = seq(
      oid("2.5.29.37"),
      der(0x04, seq(oid(clientAuth ? "1.3.6.1.5.5.7.3.2" : "1.3.6.1.5.5.7.3.1"))),
    )
    const tbs = seq(
      der(0xa0, derInt(new Uint8Array([2]))),
      derInt(new Uint8Array([serial])),
      sigAlg,
      x509Name("Test Root CA"),
      seq(utcTime(new Date(now - day)), utcTime(new Date(now + 30 * day))),
      x509Name(cn),
      kp.publicKey,
      der(0xa3, seq(san, eku)),
    )
    return {
      cert: pem("CERTIFICATE", await signTbs(tbs, caKeys.privateKey)),
      key: kp.privateKey,
    }
  }
  return {
    ca: caCert,
    server: await issue("localhost", 2, false),
    client: await issue("client-alice", 3, true),
  }
}

test("AsyncLocalStorage.enterWith() never leaks across requests or connections and serve() store is visible", async () => {
  const als = new AsyncLocalStorage<string>()
  const app = {
    fetch(req: Request): Response {
      const url = new URL(req.url)
      const initial = als.getStore() ?? "empty"
      if (url.pathname === "/enter") {
        als.enterWith(url.searchParams.get("val") ?? "unknown")
        return Response.json({ initial, current: als.getStore() })
      }
      return Response.json({ initial })
    },
  }
  const running = await als.run("serve-outer", () => serve(app, { port: 0 }))
  try {
    const first: unknown = await (
      await fetch(`http://127.0.0.1:${running.port}/enter?val=alice`)
    ).json()
    assert.deepEqual(first, { initial: "serve-outer", current: "alice" })

    const second: unknown = await (await fetch(`http://127.0.0.1:${running.port}/read`)).json()
    assert.deepEqual(second, { initial: "serve-outer" })

    // Raw TCP keep-alive pipeline: send two requests back-to-back on the SAME connection (same batch).
    const pipelined = await new Promise<string>((resolve, reject) => {
      const sock = netConnect(running.port, "127.0.0.1", () => {
        sock.write(
          "GET /enter?val=bob HTTP/1.1\r\nHost: localhost\r\n\r\n" +
            "GET /read HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )
      })
      const chunks: Buffer[] = []
      sock.on("data", (d) => chunks.push(d))
      sock.on("error", reject)
      sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    })
    assert.ok(pipelined.includes('"current":"bob"'))
    assert.ok(!pipelined.includes('"initial":"bob"'))
  } finally {
    await running.stop()
  }
})

test("AsyncLocalStorage isolation holds under --no-async-context-frame too", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { AsyncLocalStorage } from "node:async_hooks";
    import { serve } from "./packages/node-engine/dist/index.js";
    const als = new AsyncLocalStorage();
    const srv = await als.run("outer", () => serve({
      fetch(req) {
        const before = als.getStore() ?? "empty";
        if (req.url.endsWith("/set")) als.enterWith("leaked");
        return Response.json({ before });
      }
    }, { port: 0 }));
    const a = await (await fetch("http://127.0.0.1:" + srv.port + "/set")).json();
    const b = await (await fetch("http://127.0.0.1:" + srv.port + "/get")).json();
    assert.equal(a.before, "outer");
    assert.equal(b.before, "outer");
    await srv.stop();
  `
  await execFileAsync(
    process.execPath,
    ["--no-async-context-frame", "--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
    },
  )
})

test("TRACE works in plain fetch handlers and nifra routes without 500", async () => {
  const srv = await serve(
    {
      fetch(req) {
        return Response.json({ method: req.method, isReq: req instanceof Request })
      },
    },
    { port: 0 },
  )
  try {
    const rawResp = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: srv.port, method: "TRACE", path: "/probe" },
        (res) => {
          const chunks: Buffer[] = []
          res.on("data", (c) => chunks.push(c))
          res.on("end", () =>
            resolve(`${res.statusCode}:${Buffer.concat(chunks).toString("utf8")}`),
          )
        },
      )
      req.on("error", reject)
      req.end()
    })
    assert.equal(rawResp, '200:{"method":"TRACE","isReq":true}')
  } finally {
    await srv.stop()
  }
})

test("nifra routes read HTTP/1.1 chunked and HTTP/2 request trailers via c.trailers", async () => {
  const app = server().post("/trailers", async (c) => {
    await c.req.text()
    return { trailers: c.trailers }
  })
  const srv = await serve(app, { port: 0, http2: true })
  try {
    // HTTP/1.1 chunked trailers
    const h1Body = await new Promise<string>((resolve, reject) => {
      const sock = netConnect(srv.port, "127.0.0.1", () => {
        sock.write(
          "POST /trailers HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nTrailer: x-checksum\r\nConnection: close\r\n\r\n5\r\nhello\r\n0\r\nx-checksum: sha-123\r\n\r\n",
        )
      })
      const chunks: Buffer[] = []
      sock.on("data", (d) => chunks.push(d))
      sock.on("error", reject)
      sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    })
    assert.ok(h1Body.includes('"x-checksum":"sha-123"'), h1Body)

    // HTTP/2 request trailers
    const client = http2.connect(`http://127.0.0.1:${srv.port}`)
    const h2Body = await new Promise<string>((resolve, reject) => {
      const req = client.request(
        { ":method": "POST", ":path": "/trailers" },
        { waitForTrailers: true },
      )
      req.on("wantTrailers", () => {
        req.sendTrailers({ "x-h2-sig": "ok" })
      })
      const chunks: Buffer[] = []
      req.on("data", (d) => chunks.push(d))
      req.on("error", reject)
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      req.end("payload")
    })
    client.close()
    assert.ok(h2Body.includes('"x-h2-sig":"ok"'), h2Body)
  } finally {
    await srv.stop()
  }
})

test("103 Early Hints and 1xx informational responses work over HTTP/1.1 and HTTP/2", async () => {
  const srv = await serve(
    {
      fetch(req) {
        const ok103 = writeEarlyHints(req, {
          link: ["</app.css>; rel=preload", "</app.js>; rel=preload"],
        })
        const bad101 = writeInformational(req, 101, { upgrade: "websocket" })
        return Response.json({ ok103, bad101 })
      },
    },
    { port: 0, http2: true },
  )
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = netConnect(srv.port, "127.0.0.1", () => {
        sock.write("GET /hints HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
      })
      const chunks: Buffer[] = []
      sock.on("data", (d) => chunks.push(d))
      sock.on("error", reject)
      sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    })
    assert.ok(raw.startsWith("HTTP/1.1 103 Early Hints\r\n"), raw)
    assert.ok(raw.includes("link: </app.css>; rel=preload\r\n"), raw)
    assert.ok(raw.includes('"ok103":true,"bad101":false'), raw)

    const client = http2.connect(`http://127.0.0.1:${srv.port}`)
    const statuses: number[] = []
    const h2Body = await new Promise<string>((resolve, reject) => {
      const req = client.request({ ":path": "/hints" })
      req.on("headers", (headers) => {
        statuses.push(Number(headers[":status"]))
      })
      req.on("response", (headers) => {
        statuses.push(Number(headers[":status"]))
      })
      const chunks: Buffer[] = []
      req.on("data", (d) => chunks.push(d))
      req.on("error", reject)
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      req.end()
    })
    client.close()
    assert.deepEqual(statuses, [103, 200])
    assert.ok(h2Body.includes('"ok103":true,"bad101":false'))
  } finally {
    await srv.stop()
  }
})

test("mTLS getPeerCertificate exposes client certificate fields to apps", async () => {
  const bundle = await generateMtlsBundle()
  const srv = await serve(
    {
      fetch(req) {
        const cert = getPeerCertificate(req, true)
        return Response.json({
          present: cert !== null,
          subject: cert?.subject,
          fingerprint256: cert?.fingerprint256,
        })
      },
    },
    {
      port: 0,
      tls: {
        cert: bundle.server.cert,
        key: bundle.server.key,
        ca: bundle.ca,
        requestCert: true,
        rejectUnauthorized: true,
      },
    },
  )
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const sock = tls.connect(
        {
          host: "127.0.0.1",
          port: srv.port,
          ca: bundle.ca,
          cert: bundle.client.cert,
          key: bundle.client.key,
          servername: "localhost",
        },
        () => {
          sock.write("GET /whoami HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        },
      )
      const chunks: Buffer[] = []
      sock.on("data", (d) => chunks.push(d))
      sock.on("error", reject)
      sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    })
    const json: unknown = JSON.parse(body.split("\r\n\r\n")[1] ?? "{}")
    assert.ok(typeof json === "object" && json !== null)
    assert.ok("present" in json && json.present === true)
    assert.ok("subject" in json && typeof json.subject === "string")
    assert.match(json.subject, /client-alice/)
    assert.ok("fingerprint256" in json && typeof json.fingerprint256 === "string")
    assert.ok(json.fingerprint256.length > 20)
  } finally {
    await srv.stop()
  }
})

test("CONNECT tunnels work over HTTP/1.1 and HTTP/2 and can reject with Response", async () => {
  const srv = await serve(
    { fetch: () => new Response("http") },
    {
      port: 0,
      http2: true,
      onConnect(req, socket) {
        const target = new URL(req.url).host
        if (target === "blocked.example:443") {
          return new Response("Forbidden", { status: 403 })
        }
        socket.on("data", (chunk: Buffer) => {
          socket.write(Buffer.concat([Buffer.from("echo:"), chunk]))
          if (chunk.toString().includes("!done")) socket.end()
        })
      },
    },
  )
  try {
    // HTTP/1.1 CONNECT tunnel + 403 rejection
    const h1Echo = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: srv.port,
        method: "CONNECT",
        path: "echo.example:443",
      })
      req.on("connect", (res, sock) => {
        assert.equal(res.statusCode, 200)
        const chunks: Buffer[] = []
        sock.on("data", (d) => chunks.push(d))
        sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
        sock.write("hello!done")
      })
      req.on("error", reject)
      req.end()
    })
    assert.equal(h1Echo, "echo:hello!done")

    const rejected = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: srv.port,
        method: "CONNECT",
        path: "blocked.example:443",
      })
      req.on("connect", (res, sock) => {
        sock.destroy()
        resolve(res.statusCode)
      })
      req.on("error", reject)
      req.end()
    })
    assert.equal(rejected, 403)

    // HTTP/2 CONNECT tunnel
    const client = http2.connect(`http://127.0.0.1:${srv.port}`)
    const h2Echo = await new Promise<string>((resolve, reject) => {
      const stream = client.request({ ":method": "CONNECT", ":authority": "h2echo.example:443" })
      stream.on("response", (headers) => {
        assert.equal(headers[":status"], 200)
        stream.write("ping!done")
      })
      const chunks: Buffer[] = []
      stream.on("data", (d) => chunks.push(d))
      stream.on("error", reject)
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    })
    client.close()
    assert.equal(h2Echo, "echo:ping!done")
  } finally {
    await srv.stop()
  }
})

test("node:http bridge runs Express-style handlers/middlewares and publishes diagnostics_channel events", async () => {
  const events: Array<{ channel: string; status: number }> = []
  const onStart = () => events.push({ channel: "start", status: 0 })
  const onFinish = (msg: unknown) => {
    assert.ok(typeof msg === "object" && msg !== null && "response" in msg)
    assert.ok(msg.response instanceof ServerResponse)
    events.push({ channel: "finish", status: msg.response.statusCode })
  }
  diagnosticsChannel.subscribe("http.server.request.start", onStart)
  diagnosticsChannel.subscribe("http.server.response.finish", onFinish)

  try {
    const mw = fromNodeMiddleware((req, res, next) => {
      assert.ok(req instanceof IncomingMessage)
      assert.ok(res instanceof ServerResponse)
      res.setHeader("x-mw", "ran")
      if (req.url === "/deny") {
        res.statusCode = 403
        res.end("denied")
        return
      }
      next()
    })

    const app = server()
      .beforeHandle(mw)
      .get("/ok", () => ({ via: "nifra" }))
      .get("/deny", () => ({ ok: true }))
    const srv = await serve(app, { port: 0 })
    try {
      const okRes = await fetch(`http://127.0.0.1:${srv.port}/ok`)
      assert.equal(okRes.status, 200)
      assert.equal(okRes.headers.get("x-mw"), "ran")
      assert.deepEqual(await okRes.json(), { via: "nifra" })

      const denyRes = await fetch(`http://127.0.0.1:${srv.port}/deny`)
      assert.equal(denyRes.status, 403)
      assert.equal(await denyRes.text(), "denied")
    } finally {
      await srv.stop()
    }

    // Standalone Express-compatible request listener via fromNodeHandler()
    const expressLike = (req: IncomingMessage, res: ServerResponse) => {
      const customProto = Object.assign(Object.create(ServerResponse.prototype), {
        jsonBody(this: ServerResponse, v: unknown) {
          this.setHeader("content-type", "application/json")
          this.end(JSON.stringify(v))
        },
      })
      Object.setPrototypeOf(res, customProto)
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        assert.ok("jsonBody" in res && typeof res.jsonBody === "function")
        res.jsonBody({
          method: req.method,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      })
    }
    const expressSrv = await serve(fromNodeHandler(expressLike), { port: 0 })
    try {
      const resp = await fetch(`http://127.0.0.1:${expressSrv.port}/echo`, {
        method: "POST",
        body: "hi-express",
      })
      assert.equal(resp.status, 200)
      assert.deepEqual(await resp.json(), { method: "POST", body: "hi-express" })
    } finally {
      await expressSrv.stop()
    }

    assert.ok(events.some((e) => e.channel === "start"))
    assert.ok(events.some((e) => e.channel === "finish" && e.status === 200))
    assert.ok(events.some((e) => e.channel === "finish" && e.status === 403))
  } finally {
    diagnosticsChannel.unsubscribe("http.server.request.start", onStart)
    diagnosticsChannel.unsubscribe("http.server.response.finish", onFinish)
  }
})
