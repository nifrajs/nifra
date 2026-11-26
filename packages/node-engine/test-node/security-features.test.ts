/** End-to-end integration tests for TLS policy/mTLS/CRL/passphrase, RFC 7692 WS deflate, limits, response timeouts, worker cleanup, and probe capabilities. */

import assert from "node:assert/strict"
import {
  createHash,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { connect as http2Connect } from "node:http2"
import { Module } from "node:module"
import { connect as netConnect } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { connect as tlsConnect } from "node:tls"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
import { deflateRawSync } from "node:zlib"
import { server } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { WebSocket as WsClient } from "ws"
import { selfSignedCertificate } from "../../../internal/test-utils/src/tls.ts"
import { serve } from "../src/index.ts"
import { parseHead, raw, sleep } from "./support.ts"

// ---------------------------------------------------------------------------
// Pure-Node X.509 CA + Leaf + CRL DER helpers (zero external openssl dependency)
// ---------------------------------------------------------------------------

function der(tag: number, ...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const head =
    length < 0x80
      ? [tag, length]
      : length < 0x100
        ? [tag, 0x81, length]
        : [tag, 0x82, length >> 8, length & 0xff]
  const out = new Uint8Array(head.length + length)
  out.set(head)
  let off = head.length
  for (const part of parts) {
    out.set(part, off)
    off += part.length
  }
  return out
}

const seq = (...parts: readonly Uint8Array[]): Uint8Array => der(0x30, ...parts)
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

function oid(dotted: string): Uint8Array {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number)
  const bytes = [first * 40 + second]
  for (const arc of rest) {
    const groups = [arc & 0x7f]
    for (let v = arc >> 7; v > 0; v >>= 7) groups.unshift((v & 0x7f) | 0x80)
    bytes.push(...groups)
  }
  return der(0x06, new Uint8Array(bytes))
}

function derInt(magnitude: Uint8Array): Uint8Array {
  let start = 0
  while (start < magnitude.length - 1 && magnitude[start] === 0) start += 1
  const trimmed = magnitude.subarray(start)
  return (trimmed[0] ?? 0) >= 0x80 ? der(0x02, new Uint8Array([0]), trimmed) : der(0x02, trimmed)
}

function utcTime(date: Date): Uint8Array {
  const two = (n: number): string => String(n).padStart(2, "0")
  return der(
    0x17,
    utf8(
      `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}` +
        `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`,
    ),
  )
}

function bitString(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1)
  out[0] = 0
  out.set(bytes, 1)
  return der(0x03, out)
}

const x509Name = (cn: string): Uint8Array =>
  seq(der(0x31, seq(oid("2.5.4.3"), der(0x0c, utf8(cn)))))

function pemEncode(label: string, bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString("base64")
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

function signDer(tbs: Uint8Array, signerPrivateKeyPem: string): Uint8Array {
  const sig = createSign("SHA256").update(tbs).sign(signerPrivateKeyPem)
  const sigAlg = seq(oid("1.2.840.10045.4.3.2"))
  return seq(tbs, sigAlg, bitString(sig))
}

interface CaBundle {
  readonly cert: string
  readonly key: string
  readonly subjectName: string
}

function createCa(subjectName: string): CaBundle {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  const now = Date.now()
  const day = 86_400_000
  const serial = randomBytes(8)
  serial[0] = (serial[0] ?? 0) & 0x7f
  const sigAlg = seq(oid("1.2.840.10045.4.3.2"))
  // BasicConstraints CA=true (critical) + KeyUsage keyCertSign (bit 5) | cRLSign (bit 6)
  const basicConstraints = seq(
    oid("2.5.29.19"),
    der(0x01, new Uint8Array([0xff])),
    der(0x04, seq(der(0x01, new Uint8Array([0xff])))),
  )
  const keyUsage = seq(
    oid("2.5.29.15"),
    der(0x01, new Uint8Array([0xff])),
    der(0x04, bitString(new Uint8Array([0x06]))),
  )
  const tbs = seq(
    der(0xa0, derInt(new Uint8Array([2]))),
    derInt(serial),
    sigAlg,
    x509Name(subjectName),
    seq(utcTime(new Date(now - day)), utcTime(new Date(now + 30 * day))),
    x509Name(subjectName),
    publicKey,
    der(0xa3, seq(basicConstraints, keyUsage)),
  )
  return { cert: pemEncode("CERTIFICATE", signDer(tbs, privateKey)), key: privateKey, subjectName }
}

function issueSignedCert(
  ca: CaBundle,
  commonName: string,
  serialNum: number,
  options: { readonly serverAuth?: boolean; readonly clientAuth?: boolean } = {},
): { readonly cert: string; readonly key: string; readonly serial: number } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  const now = Date.now()
  const day = 86_400_000
  const sigAlg = seq(oid("1.2.840.10045.4.3.2"))
  const san = seq(
    oid("2.5.29.17"),
    der(0x04, seq(der(0x82, utf8("localhost")), der(0x87, new Uint8Array([127, 0, 0, 1])))),
  )
  const ekuOids: Uint8Array[] = []
  if (options.serverAuth) ekuOids.push(oid("1.3.6.1.5.5.7.3.1"))
  if (options.clientAuth) ekuOids.push(oid("1.3.6.1.5.5.7.3.2"))
  const exts: Uint8Array[] = [san]
  if (ekuOids.length > 0) exts.push(seq(oid("2.5.29.37"), der(0x04, seq(...ekuOids))))

  const tbs = seq(
    der(0xa0, derInt(new Uint8Array([2]))),
    derInt(new Uint8Array([serialNum])),
    sigAlg,
    x509Name(ca.subjectName),
    seq(utcTime(new Date(now - day)), utcTime(new Date(now + 30 * day))),
    x509Name(commonName),
    publicKey,
    der(0xa3, seq(...exts)),
  )
  return {
    cert: pemEncode("CERTIFICATE", signDer(tbs, ca.key)),
    key: privateKey,
    serial: serialNum,
  }
}

function createCrl(ca: CaBundle, revokedSerials: readonly number[]): string {
  const now = Date.now()
  const day = 86_400_000
  const sigAlg = seq(oid("1.2.840.10045.4.3.2"))
  const entries = revokedSerials.map((serialNum) =>
    seq(derInt(new Uint8Array([serialNum])), utcTime(new Date(now - 60_000))),
  )
  const crlNumberExt = seq(oid("2.5.29.20"), der(0x04, derInt(new Uint8Array([1]))))
  const tbsParts: Uint8Array[] = [
    derInt(new Uint8Array([1])), // CRL v2
    sigAlg,
    x509Name(ca.subjectName),
    utcTime(new Date(now - 60_000)),
    utcTime(new Date(now + 7 * day)),
  ]
  if (entries.length > 0) tbsParts.push(seq(...entries))
  tbsParts.push(der(0xa0, seq(crlNumberExt)))
  const tbs = seq(...tbsParts)
  return pemEncode("X509 CRL", signDer(tbs, ca.key))
}

function loadNativeProbe() {
  const here = dirname(fileURLToPath(import.meta.url))
  const engineRoot = resolve(here, "../../../native/nifra-engine")
  const lib =
    process.platform === "win32"
      ? "nifra_napi.dll"
      : process.platform === "darwin"
        ? "libnifra_napi.dylib"
        : "libnifra_napi.so"
  const binary =
    process.env.NIFRA_RUST_ENGINE_PATH ??
    [`target/release/${lib}`, `target/debug/${lib}`, "nifra_napi.node"]
      .map((name) => join(engineRoot, name))
      .find(existsSync)
  assert.ok(binary, "native engine binary exists")
  const mod = new Module(binary)
  process.dlopen(mod, binary)
  type ProbeFn = () => { ok: boolean; transport: string; capabilities: Record<string, boolean> }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: test loads native addon export shape
  const exportsObj = mod.exports as { probe: ProbeFn }
  return exportsObj.probe()
}

function httpsGet(
  port: number,
  options: {
    readonly ca?: string
    readonly cert?: string
    readonly key?: string
    readonly minVersion?: "TLSv1.2" | "TLSv1.3"
    readonly maxVersion?: "TLSv1.2" | "TLSv1.3"
    readonly ciphers?: string
    readonly ecdhCurve?: string
    readonly session?: Buffer
    readonly rejectUnauthorized?: boolean
  } = {},
): Promise<{
  readonly status: number
  readonly cipher?: string
  readonly protocol?: string | null
  readonly reused: boolean
  readonly ticket: Buffer | undefined
}> {
  return new Promise((resolvePromise, reject) => {
    const sock = tlsConnect(
      {
        port,
        host: "127.0.0.1",
        servername: "localhost",
        ca: options.ca,
        cert: options.cert,
        key: options.key,
        minVersion: options.minVersion,
        maxVersion: options.maxVersion,
        ciphers: options.ciphers,
        ecdhCurve: options.ecdhCurve,
        session: options.session,
        rejectUnauthorized: options.rejectUnauthorized ?? true,
      },
      () => {
        sock.write("GET /ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
      },
    )
    let buf = ""
    let settled = false
    let capturedTicket: Buffer | undefined
    sock.on("session", (sess) => {
      capturedTicket = sess
    })
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1")
    })
    sock.on("end", () => {
      if (settled) return
      settled = true
      const status = parseHead(buf).status
      const cipher = sock.getCipher()?.name
      const protocol = sock.getProtocol()
      const reused = sock.isSessionReused()
      sock.destroy()
      resolvePromise({ status, cipher, protocol, reused, ticket: capturedTicket })
    })
    sock.on("error", (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

// ---------------------------------------------------------------------------
// 1. Passphrase-protected private keys + reload
// ---------------------------------------------------------------------------

test("passphrase decrypts inline and file private keys on start and reloadTls", async () => {
  const [certA, certB] = [await selfSignedCertificate(), await selfSignedCertificate()]
  const passA = "alpha-pass-123"
  const passB = "beta-pass-456"
  const encKeyA = createPrivateKey(certA.key).export({
    format: "pem",
    type: "pkcs8",
    cipher: "aes-256-cbc",
    passphrase: passA,
  })
  const encKeyB = createPrivateKey(certB.key).export({
    format: "pem",
    type: "pkcs8",
    cipher: "aes-256-cbc",
    passphrase: passB,
  })
  const app = server().get("/ping", () => ({ ok: true }))

  assert.throws(
    () =>
      serve(app, {
        port: 0,
        hostname: "127.0.0.1",
        tls: { cert: certA.cert, key: encKeyA, passphrase: "wrong" },
      }),
    /.+/,
  )

  const dir = await mkdtemp(join(tmpdir(), "nifra-pass-"))
  const certFile = join(dir, "cert.pem")
  const keyFile = join(dir, "key.pem")
  await writeFile(certFile, certA.cert)
  await writeFile(keyFile, encKeyA)

  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert_file_name: certFile, key_file_name: keyFile, passphrase: passA },
  })
  try {
    const r1 = await httpsGet(running.port, { ca: certA.cert })
    assert.equal(r1.status, 200)

    await writeFile(certFile, certB.cert)
    await writeFile(keyFile, encKeyB)
    // Wrong passphrase leaves certA active and throws synchronously.
    assert.throws(() =>
      running.reloadTls({ cert_file_name: certFile, key_file_name: keyFile, passphrase: "wrong" }),
    )
    assert.equal((await httpsGet(running.port, { ca: certA.cert })).status, 200)

    running.reloadTls({ cert_file_name: certFile, key_file_name: keyFile, passphrase: passB })
    assert.equal((await httpsGet(running.port, { ca: certB.cert })).status, 200)
  } finally {
    await running.stop({ drainMs: 50 })
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. mTLS (ca, crl, requestCert, rejectUnauthorized)
// ---------------------------------------------------------------------------

test("mTLS verifies client certs, rejects revoked CRL serials, and respects rejectUnauthorized", async () => {
  const serverCa = createCa("Server CA")
  const clientCa = createCa("Client CA")
  const rogueCa = createCa("Rogue CA")

  const serverLeaf = issueSignedCert(serverCa, "localhost", 1, { serverAuth: true })
  const clientGood = issueSignedCert(clientCa, "alice", 10, { clientAuth: true })
  const clientRevoked = issueSignedCert(clientCa, "mallory", 20, { clientAuth: true })
  const clientRogue = issueSignedCert(rogueCa, "eve", 30, { clientAuth: true })
  const crlPem = createCrl(clientCa, [clientRevoked.serial])

  const running = await serve(
    server().get("/ping", () => ({ ok: true })),
    {
      port: 0,
      hostname: "127.0.0.1",
      tls: {
        cert: serverLeaf.cert,
        key: serverLeaf.key,
        ca: clientCa.cert,
        crl: crlPem,
        requestCert: true,
        rejectUnauthorized: true,
      },
    },
  )

  try {
    const ok = await httpsGet(running.port, {
      ca: serverCa.cert,
      cert: clientGood.cert,
      key: clientGood.key,
    })
    assert.equal(ok.status, 200)

    await assert.rejects(httpsGet(running.port, { ca: serverCa.cert }))
    await assert.rejects(
      httpsGet(running.port, { ca: serverCa.cert, cert: clientRogue.cert, key: clientRogue.key }),
    )
    await assert.rejects(
      httpsGet(running.port, {
        ca: serverCa.cert,
        cert: clientRevoked.cert,
        key: clientRevoked.key,
      }),
    )

    // Relaxing to allow unauthenticated clients permits anonymous connections while still
    // rejecting explicitly presented revoked or untrusted certificates.
    running.reloadTls({
      cert: serverLeaf.cert,
      key: serverLeaf.key,
      ca: clientCa.cert,
      crl: crlPem,
      requestCert: true,
      rejectUnauthorized: false,
    })
    const anon = await httpsGet(running.port, { ca: serverCa.cert })
    assert.equal(anon.status, 200)
    await assert.rejects(
      httpsGet(running.port, {
        ca: serverCa.cert,
        cert: clientRevoked.cert,
        key: clientRevoked.key,
      }),
    )
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

// ---------------------------------------------------------------------------
// 3. TLS protocol bounds, ciphers, ecdhCurve & session-ticket isolation
// ---------------------------------------------------------------------------

test("TLS policy enforces minVersion, ciphers, ecdhCurve, and rotates tickets when policy changes", async () => {
  const leaf = await selfSignedCertificate()
  const running = await serve(
    server().get("/ping", () => ({ ok: true })),
    {
      port: 0,
      hostname: "127.0.0.1",
      tls: {
        cert: leaf.cert,
        key: leaf.key,
        minVersion: "TLSv1.2",
        ciphers: "TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES256-GCM-SHA384",
        ecdhCurve: "P-256:P-384",
      },
    },
  )

  try {
    const first = await httpsGet(running.port, {
      ca: leaf.cert,
      minVersion: "TLSv1.3",
      ciphers: "TLS_AES_256_GCM_SHA384",
      ecdhCurve: "P-384",
    })
    assert.equal(first.status, 200)
    assert.equal(first.cipher, "TLS_AES_256_GCM_SHA384")
    assert.equal(first.protocol, "TLSv1.3")

    // Disallowed cipher / disallowed curve rejected at handshake.
    await assert.rejects(
      httpsGet(running.port, {
        ca: leaf.cert,
        minVersion: "TLSv1.3",
        ciphers: "TLS_CHACHA20_POLY1305_SHA256",
        ecdhCurve: "P-384",
      }),
    )
    await assert.rejects(
      httpsGet(running.port, {
        ca: leaf.cert,
        minVersion: "TLSv1.3",
        ciphers: "TLS_AES_256_GCM_SHA384",
        ecdhCurve: "X25519",
      }),
    )

    // Capture a TLS 1.2 session ticket before tightening security policy.
    const t12 = await httpsGet(running.port, {
      ca: leaf.cert,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      ciphers: "ECDHE-ECDSA-AES256-GCM-SHA384",
      ecdhCurve: "P-256",
    })
    assert.equal(t12.protocol, "TLSv1.2")
    assert.ok(t12.ticket)

    // Tightening minVersion to TLSv1.3 rejects TLSv1.2 clients AND invalidates pre-reload tickets.
    running.reloadTls({
      cert: leaf.cert,
      key: leaf.key,
      minVersion: "TLSv1.3",
      ciphers: "TLS_AES_256_GCM_SHA384",
      ecdhCurve: "P-384",
    })
    await assert.rejects(
      httpsGet(running.port, {
        ca: leaf.cert,
        maxVersion: "TLSv1.2",
        ciphers: "ECDHE-ECDSA-AES256-GCM-SHA384",
        ecdhCurve: "P-256",
      }),
    )
    const afterTighten = await httpsGet(running.port, {
      ca: leaf.cert,
      ciphers: "TLS_AES_256_GCM_SHA384",
      ecdhCurve: "P-384",
      session: t12.ticket,
    })
    assert.equal(afterTighten.reused, false)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

// ---------------------------------------------------------------------------
// 4. WebSocket permessage-deflate (RFC 7692) + zip-bomb defense + maxLifetime
// ---------------------------------------------------------------------------

test("wsDeflate negotiates RFC 7692 permessage-deflate, shares compressors, and blocks zip bombs with 1009", async () => {
  const app = server()
    .use(websocket())
    .ws("/echo", {
      message(ws, data) {
        ws.send(data)
      },
    })

  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    wsMaxMessageSize: 8192,
    wsDeflate: {
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      serverMaxWindowBits: 12,
      clientMaxWindowBits: 12,
      threshold: 0,
      maxDecompressedSize: 2048,
      sharedCompressor: true,
    },
  })

  try {
    const client = new WsClient(`ws://127.0.0.1:${running.port}/echo`, {
      perMessageDeflate: { clientNoContextTakeover: true, serverNoContextTakeover: true },
    })
    await new Promise<void>((resolvePromise, reject) => {
      client.once("open", () => resolvePromise())
      client.once("error", reject)
    })
    assert.ok(client.extensions.includes("permessage-deflate"))

    const payload = "repeat-segment-".repeat(64)
    const received = await new Promise<string>((resolvePromise, reject) => {
      client.once("message", (data) => resolvePromise(data.toString("utf8")))
      client.once("error", reject)
      client.send(payload)
    })
    assert.equal(received, payload)
    client.close(1000, "done")
    await sleep(30)

    // Zip bomb: valid <100 byte compressed wire frame inflating to 4096 bytes (> maxDecompressedSize 2048).
    const compressed = deflateRawSync(Buffer.alloc(4096, 0x41)).subarray(0)
    const trimmed = compressed.subarray(0, compressed.length - 4)
    const bombClose = await new Promise<number>((resolvePromise, reject) => {
      const sock = netConnect(running.port, "127.0.0.1", () => {
        sock.write(
          "GET /echo HTTP/1.1\r\n" +
            "Host: localhost\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n",
        )
      })
      const failSocket = (err: unknown): void => {
        sock.destroy()
        reject(err)
      }
      let upgraded = false
      let acc = Buffer.alloc(0)
      sock.on("data", (chunk) => {
        try {
          acc = Buffer.concat([acc, chunk])
          if (!upgraded) {
            const end = acc.indexOf("\r\n\r\n")
            if (end === -1) return
            const headText = acc.subarray(0, end).toString("latin1")
            assert.ok(headText.toLowerCase().includes("permessage-deflate"))
            upgraded = true
            acc = acc.subarray(end + 4)

            // Send masked binary frame with RSV1=1 (0x80 | 0x40 | 0x02 = 0xC2).
            const mask = Buffer.from([1, 2, 3, 4])
            const hdr = Buffer.alloc(6)
            hdr[0] = 0xc2
            hdr[1] = 0x80 | trimmed.length
            mask.copy(hdr, 2)
            const masked = Buffer.from(trimmed)
            for (let i = 0; i < masked.length; i++)
              masked[i] = (masked[i] ?? 0) ^ (mask[i & 3] ?? 0)
            sock.write(Buffer.concat([hdr, masked]))
          }
          if (upgraded && acc.length >= 4 && (acc[0] & 0x0f) === 0x08) {
            const closeCode = acc.readUInt16BE(2)
            sock.destroy()
            resolvePromise(closeCode)
          }
        } catch (err) {
          failSocket(err)
        }
      })
      sock.on("error", failSocket)
    })
    assert.equal(bombClose, 1009)
  } finally {
    await running.stop({ drainMs: 50 })
  }

  // wsMaxLifetimeMs closes idle/open WebSockets past configured lifetime.
  const timed = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    engine: { idleTimeoutMs: 0, wsMaxLifetimeMs: 120 },
  })
  try {
    const ws = new WsClient(`ws://127.0.0.1:${timed.port}/echo`, { perMessageDeflate: false })
    const code = await new Promise<number>((resolvePromise, reject) => {
      ws.once("close", (c) => resolvePromise(c))
      ws.once("error", reject)
    })
    assert.equal(code, 1006)
  } finally {
    await timed.stop({ drainMs: 50 })
  }
})

// ---------------------------------------------------------------------------
// 5. Caller-exposed HTTP/1.1 & HTTP/2 limits (414 URI, 431 headers/headSize)
// ---------------------------------------------------------------------------

test("enforces maxUriSize (414) and maxHeaders / maxHeadSize (431) in HTTP/1.1 and HTTP/2", async () => {
  const leaf = await selfSignedCertificate()
  const running = await serve(
    server().get("/*", () => ({ ok: true })),
    {
      port: 0,
      hostname: "127.0.0.1",
      http2: true,
      tls: { cert: leaf.cert, key: leaf.key },
      engine: {
        maxUriSize: 20,
        maxHeaders: 5,
        maxHeadSize: 512,
        maxPendingBytes: 65_536,
        responseBackpressureLimit: 1024 * 1024,
        writeHighWaterMark: 4096,
        backlog: 128,
      },
    },
  )

  // Plaintext HTTP/1.1 tests on another instance without TLS.
  const plain = await serve(
    server().get("/*", () => ({ ok: true })),
    {
      port: 0,
      hostname: "127.0.0.1",
      engine: {
        maxUriSize: 20,
        maxHeaders: 5,
        maxHeadSize: 512,
        backlog: 128,
      },
    },
  )

  try {
    const okH1 = parseHead(
      await raw(plain.port, "GET /short HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n"),
    )
    assert.equal(okH1.status, 200)

    const longUriH1 = parseHead(
      await raw(
        plain.port,
        `GET /${"a".repeat(25)} HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n`,
      ),
    )
    assert.equal(longUriH1.status, 414)

    const manyHdrH1 = parseHead(
      await raw(
        plain.port,
        "GET / HTTP/1.1\r\nHost: h\r\nX-1: 1\r\nX-2: 2\r\nX-3: 3\r\nX-4: 4\r\nX-5: 5\r\nConnection: close\r\n\r\n",
      ),
    )
    assert.equal(manyHdrH1.status, 431)

    const fatHeadH1 = parseHead(
      await raw(
        plain.port,
        `GET / HTTP/1.1\r\nHost: h\r\nX-Big: ${"x".repeat(600)}\r\nConnection: close\r\n\r\n`,
      ),
    )
    assert.equal(fatHeadH1.status, 431)

    // HTTP/2 over TLS
    const client = http2Connect(`https://127.0.0.1:${running.port}`, { ca: leaf.cert })
    try {
      const h2Req = (headers: Record<string, string>): Promise<number> =>
        new Promise((resolvePromise, reject) => {
          const req = client.request(headers)
          req.once("response", (res) => {
            res
            req.resume()
            req.once("end", () => resolvePromise(Number(res[":status"])))
          })
          req.once("error", reject)
          req.end()
        })

      assert.equal(await h2Req({ ":path": "/short" }), 200)
      assert.equal(await h2Req({ ":path": `/${"b".repeat(25)}` }), 414)
      assert.equal(
        await h2Req({
          ":path": "/ok",
          "x-1": "1",
          "x-2": "2",
          "x-3": "3",
          "x-4": "4",
          "x-5": "5",
          "x-6": "6",
        }),
        431,
      )
    } finally {
      client.close()
    }
  } finally {
    await Promise.all([running.stop({ drainMs: 50 }), plain.stop({ drainMs: 50 })])
  }
})

// ---------------------------------------------------------------------------
// 6. Progress-aware responseTimeoutMs + idleSparesDrainingResponse
// ---------------------------------------------------------------------------

test("idleTimeoutMs spares healthy slow drains while responseTimeoutMs closes stalled readers", async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 0x7a)
  const expectedDigest = createHash("sha256").update(big).digest("hex")
  const app = server().get(
    "/big",
    () =>
      new Response(big, {
        headers: {
          "content-length": String(big.length),
          "content-type": "application/octet-stream",
        },
      }),
  )

  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    engine: { idleTimeoutMs: 120, responseTimeoutMs: 250, writeHighWaterMark: 4096 },
  })

  try {
    // Slow healthy reader: throttles via pause()/resume() for ~420ms (exceeding BOTH 120ms idle and
    // 250ms total responseTimeoutMs window), proving steady socket progress keeps connection alive.
    const slowHash = await new Promise<string>((resolvePromise, reject) => {
      const h = createHash("sha256")
      let seenBody = false
      let headerRest = ""
      let expectedLen = -1
      let gotLen = 0
      const sock = netConnect(running.port, "127.0.0.1", () => {
        sock.write("GET /big HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
      })
      const timer = setInterval(() => {
        if (!sock.destroyed && sock.isPaused()) sock.resume()
      }, 35)
      const fail = (err: unknown): void => {
        clearInterval(timer)
        sock.destroy()
        reject(err)
      }
      sock.on("data", (chunk) => {
        if (!seenBody) {
          headerRest += chunk.toString("latin1")
          const end = headerRest.indexOf("\r\n\r\n")
          if (end === -1) return
          seenBody = true
          const head = headerRest.slice(0, end)
          const match = /content-length:\s*(\d+)/i.exec(head)
          expectedLen = Number(match?.[1] ?? 0)
          const initial = Buffer.from(headerRest.slice(end + 4), "latin1")
          gotLen += initial.length
          h.update(initial)
        } else {
          gotLen += chunk.length
          h.update(chunk)
        }
        sock.pause()
        if (gotLen >= expectedLen) sock.resume()
      })
      sock.once("end", () => {
        clearInterval(timer)
        if (gotLen !== expectedLen) {
          sock.destroy()
          reject(new Error(`expected ${expectedLen} bytes, received ${gotLen}`))
          return
        }
        resolvePromise(h.digest("hex"))
      })
      sock.once("error", fail)
    })
    assert.equal(slowHash, expectedDigest)
  } finally {
    await running.stop({ drainMs: 50 })
  }

  // Zero-progress stalled peer (does not read large 32MB response once TCP buffers saturate)
  // triggers responseTimeoutMs well before idle/shutdown and invokes stream cancel() / onAborted.
  let abortedResolve: (() => void) | undefined
  const abortedPromise = new Promise<void>((r) => {
    abortedResolve = r
  })
  const stalledSrv = await serve(
    server().get("/huge", () => {
      let sent = 0
      const total = 32 * 1024 * 1024
      const chunk = Buffer.alloc(256 * 1024, 0x62)
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= total) return controller.close()
            sent += chunk.length
            controller.enqueue(chunk)
          },
          cancel() {
            abortedResolve?.()
          },
        }),
        { headers: { "content-length": String(total) } },
      )
    }),
    {
      port: 0,
      hostname: "127.0.0.1",
      engine: { idleTimeoutMs: 0, responseTimeoutMs: 250, requestTimeoutMs: 0 },
    },
  )
  let stalledSock: ReturnType<typeof netConnect> | undefined
  try {
    const start = Date.now()
    stalledSock = netConnect(stalledSrv.port, "127.0.0.1", () => {
      stalledSock?.pause()
      stalledSock?.write("GET /huge HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
    })
    await Promise.race([
      abortedPromise,
      sleep(5000).then(() => {
        throw new Error("stalled peer was not reaped by responseTimeoutMs")
      }),
    ])
    assert.ok(Date.now() - start < 5000)
  } finally {
    stalledSock?.destroy()
    await stalledSrv.stop({ drainMs: 50 })
  }
})

// ---------------------------------------------------------------------------
// 7. worker_threads termination cleanup hook
// ---------------------------------------------------------------------------

test("terminating a worker_threads worker closes its engine server via env cleanup hook", async () => {
  const distUrl = pathToFileURL(
    resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js"),
  ).href
  const coreDist = pathToFileURL(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../core/dist/index.js"),
  ).href

  const workerCode = `
    import { parentPort } from "node:worker_threads";
    import { server } from ${JSON.stringify(coreDist)};
    import { serve } from ${JSON.stringify(distUrl)};
    const running = await serve(server().get("/ping", () => ({ worker: true })), {
      port: 0,
      hostname: "127.0.0.1",
    });
    parentPort.postMessage({ port: running.port });
  `
  const worker = new Worker(workerCode, { eval: true })
  const port = await new Promise<number>((resolvePromise, reject) => {
    worker.once("message", (msg: { port: number }) => resolvePromise(msg.port))
    worker.once("error", reject)
  })

  const liveRes = await fetch(`http://127.0.0.1:${port}/ping`)
  assert.equal(liveRes.status, 200)
  await liveRes.body?.cancel()

  const exitCode = await worker.terminate()
  assert.equal(exitCode, 1)

  // Port must be completely free and re-bindable after worker termination.
  const rebound = await serve(
    server().get("/ping", () => ({ rebound: true })),
    {
      port,
      hostname: "127.0.0.1",
    },
  )
  try {
    assert.equal(rebound.port, port)
  } finally {
    await rebound.stop({ drainMs: 50 })
  }
})

// ---------------------------------------------------------------------------
// 8. Honest probe() & capabilities reporting
// ---------------------------------------------------------------------------

test("probe reports honest active transport and implemented security/feature capabilities", () => {
  const res = loadNativeProbe()
  assert.equal(res.ok, true)
  const expectedTransport = process.platform === "linux" ? "epoll" : "libuv-poll"
  assert.equal(res.transport, expectedTransport)
  assert.equal(res.capabilities.tls, true)
  assert.equal(res.capabilities.tlsCrl, true)
  assert.equal(res.capabilities.tlsPolicy, true)
  assert.equal(res.capabilities.mtls, true)
  assert.equal(res.capabilities.wsPerMessageDeflate, true)
  assert.equal(res.capabilities.responseLimits, true)
  assert.equal(res.capabilities.idleSparesDrainingResponse, true)
  assert.equal(res.capabilities.envCleanupHook, true)
})
