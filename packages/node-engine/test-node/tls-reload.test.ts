/** Certificate reload: new handshakes get the new certificate, open connections keep theirs. */

import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { connect as http2Connect } from "node:http2"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { connect as tlsConnect } from "node:tls"
import { server } from "@nifrajs/core"
import { selfSignedCertificate } from "../../../internal/test-utils/src/tls.ts"
import { serve } from "../src/index.ts"

/** The fingerprint of the certificate a fresh TLS handshake is given, over a handshake that trusts only `trusted`: a second certificate with the same subject would shadow it. */
function presented(port: number, trusted: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ port, host: "127.0.0.1", ca: trusted }, () => {
      const fingerprint = socket.getPeerCertificate().fingerprint256
      socket.destroy()
      resolve(fingerprint)
    })
    socket.on("error", reject)
  })
}

const fingerprintOf = async (cert: string): Promise<string> => {
  const { X509Certificate } = await import("node:crypto")
  return new X509Certificate(cert).fingerprint256
}

const app = () => server().get("/ping", () => ({ pong: true }))

test("a reload gives new handshakes the new certificate and leaves an open connection on the old", async () => {
  const [a, b] = [await selfSignedCertificate(), await selfSignedCertificate()]
  const running = await serve(app(), {
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: a.cert, key: a.key },
  })
  const [fpA, fpB] = [await fingerprintOf(a.cert), await fingerprintOf(b.cert)]
  assert.notEqual(fpA, fpB)
  try {
    assert.equal(await presented(running.port, a.cert), fpA)
    const held = tlsConnect({ port: running.port, host: "127.0.0.1", ca: a.cert })
    await new Promise<void>((resolve) => held.once("secureConnect", () => resolve()))
    running.reloadTls({ cert: b.cert, key: b.key })
    assert.equal(await presented(running.port, b.cert), fpB)
    assert.equal(held.getPeerCertificate().fingerprint256, fpA)
    // The held connection still answers.
    const reply = new Promise<string>((resolve) =>
      held.once("data", (chunk) => resolve(chunk.toString())),
    )
    held.write("GET /ping HTTP/1.1\r\nhost: x\r\n\r\n")
    assert.match(await reply, /^HTTP\/1\.1 200/)
    held.destroy()
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("rotated certificate files are picked up by a reload with no argument", async () => {
  const [a, b] = [await selfSignedCertificate(), await selfSignedCertificate()]
  const dir = await mkdtemp(join(tmpdir(), "node-engine-reload-"))
  const certFile = join(dir, "cert.pem")
  const keyFile = join(dir, "key.pem")
  await writeFile(certFile, a.cert)
  await writeFile(keyFile, a.key)
  const running = await serve(app(), {
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert_file_name: certFile, key_file_name: keyFile },
  })
  try {
    assert.equal(await presented(running.port, a.cert), await fingerprintOf(a.cert))
    await writeFile(certFile, b.cert)
    await writeFile(keyFile, b.key)
    running.reloadTls()
    assert.equal(await presented(running.port, b.cert), await fingerprintOf(b.cert))
  } finally {
    await running.stop({ drainMs: 50 })
    await rm(dir, { recursive: true, force: true })
  }
})

test("material the engine refuses throws and leaves the certificate in place", async () => {
  const [a, b] = [await selfSignedCertificate(), await selfSignedCertificate()]
  const running = await serve(app(), {
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: a.cert, key: a.key },
  })
  try {
    // A certificate with another certificate's key.
    assert.throws(() => running.reloadTls({ cert: a.cert, key: b.key }))
    assert.throws(() => running.reloadTls({ cert: "not pem", key: "not pem" }))
    assert.equal(await presented(running.port, a.cert), await fingerprintOf(a.cert))
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a reload reaches HTTP/2 handshakes too", async () => {
  const [a, b] = [await selfSignedCertificate(), await selfSignedCertificate()]
  const running = await serve(app(), {
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: a.cert, key: a.key },
    http2: true,
  })
  try {
    running.reloadTls({ cert: b.cert, key: b.key })
    const session = http2Connect(`https://127.0.0.1:${running.port}`, { ca: b.cert })
    const status = await new Promise<number>((resolve, reject) => {
      const stream = session.request({ ":path": "/ping" })
      stream.on("response", (head) => resolve(Number(head[":status"])))
      stream.on("error", reject)
      stream.resume()
      stream.end()
    })
    assert.equal(status, 200)
    assert.equal(session.alpnProtocol, "h2")
    session.close()
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a server without TLS, and one that has stopped, refuse a reload", async () => {
  const plain = await serve(app(), { port: 0, hostname: "127.0.0.1" })
  try {
    assert.throws(() => plain.reloadTls(), /requires a server started with `tls`/)
  } finally {
    await plain.stop({ drainMs: 50 })
  }
  const pair = await selfSignedCertificate()
  const secure = await serve(app(), {
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: pair.cert, key: pair.key },
  })
  await secure.stop({ drainMs: 50 })
  assert.throws(() => secure.reloadTls(), /not running/)
})
