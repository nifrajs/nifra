/** Clustering: a supervised set of engine workers sharing one port. */

import assert from "node:assert/strict"
import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes, X509Certificate } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { connect as tlsConnect } from "node:tls"
import { selfSignedCertificate } from "../../../internal/test-utils/src/tls.ts"
import { serveCluster } from "../src/cluster.ts"

const FIXTURE = new URL("./fixtures/cluster-server.ts", import.meta.url).pathname

interface Event {
  readonly event: string
  readonly [key: string]: unknown
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

/** A cluster entry run as its own process, with its JSON log lines collected. */
class Run {
  readonly events: Event[] = []
  readonly child: ChildProcess
  readonly exited: Promise<number | null>
  private waiting: Array<() => void> = []

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [FIXTURE], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "inherit"],
    })
    let buffer = ""
    this.child.stdout?.setEncoding("utf8")
    this.child.stdout?.on("data", (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        try {
          this.events.push(JSON.parse(line))
        } catch {
          continue
        }
        for (const wake of this.waiting.splice(0)) wake()
      }
    })
    this.exited = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)))
  }

  /** The `n`th event named `name`, waiting for it. */
  async nth(name: string, n = 1, timeoutMs = 10_000): Promise<Event> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.events.filter((event) => event.event === name)[n - 1]
      if (found !== undefined) return found
      if (Date.now() > deadline)
        throw new Error(`no "${name}" #${n}: ${JSON.stringify(this.events)}`)
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve)
        setTimeout(resolve, 100)
      })
    }
  }

  kill(): void {
    this.child.kill("SIGKILL")
  }
}

/** The worker pids a `ready` event lists. */
function pidsOf(event: Event): number[] {
  const workers = event.workers
  if (!Array.isArray(workers)) throw new Error("no workers in the event")
  return workers.map((worker) => pidField(worker, "a worker without a pid"))
}

function pidField(value: unknown, failure: string): number {
  if (typeof value !== "object" || value === null || !("pid" in value)) throw new Error(failure)
  if (typeof value.pid !== "number") throw new Error(failure)
  return value.pid
}

async function pidOf(port: number): Promise<number> {
  const body: unknown = await (await fetch(`http://127.0.0.1:${port}/pid`)).json()
  return pidField(body, "no pid in the answer")
}

test("every worker comes up on one port and the primary answers through them", async () => {
  const port = await freePort()
  const run = new Run({ PORT: String(port), WORKERS: "3" })
  try {
    const ready = await run.nth("ready")
    const pids = new Set(pidsOf(ready))
    assert.equal(pids.size, 3)
    const answered = new Set<number>()
    for (let i = 0; i < 30; i++) answered.add(await pidOf(port))
    for (const pid of answered) assert.ok(pids.has(pid), "a request was answered by a stranger")
  } finally {
    run.child.kill("SIGTERM")
    assert.equal(await run.exited, 0)
  }
})

test("a worker that dies is replaced", async () => {
  const port = await freePort()
  const run = new Run({ PORT: String(port), WORKERS: "2" })
  try {
    const ready = await run.nth("ready")
    const [victim] = pidsOf(ready)
    assert.ok(victim)
    process.kill(victim, "SIGKILL")
    const gone = await run.nth("exit")
    assert.equal(gone.pid, victim)
    assert.equal(gone.respawning, true)
    const back = await run.nth("listening", 3)
    assert.notEqual(back.pid, victim)
    assert.ok(await pidOf(port))
  } finally {
    run.child.kill("SIGTERM")
    assert.equal(await run.exited, 0)
  }
})

test("SIGTERM to the primary stops every worker and frees the port", async () => {
  const port = await freePort()
  const run = new Run({ PORT: String(port), WORKERS: "3" })
  const ready = await run.nth("ready")
  const pids = pidsOf(ready)
  run.child.kill("SIGTERM")
  assert.equal(await run.exited, 0)
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), "a worker outlived the primary")
  }
  await assert.rejects(fetch(`http://127.0.0.1:${port}/pid`))
  assert.equal(run.events.filter((event) => event.respawning === true).length, 0)
})

test("a worker that cannot start fails the primary and leaves nothing running", async () => {
  const port = await freePort()
  const run = new Run({ PORT: String(port), WORKERS: "2", FAIL: "1" })
  assert.equal(await run.exited, 1)
  const failed = await run.nth("failed")
  assert.match(String(failed.message), /factory refused/)
})

test("a reload reaches every worker", async () => {
  const [a, b] = [await selfSignedCertificate(), await selfSignedCertificate()]
  const dir = await mkdtemp(join(tmpdir(), "node-engine-cluster-"))
  const certFile = join(dir, "cert.pem")
  const keyFile = join(dir, "key.pem")
  await writeFile(certFile, a.cert)
  await writeFile(keyFile, a.key)
  const port = await freePort()
  const run = new Run({
    PORT: String(port),
    WORKERS: "3",
    CERT_FILE: certFile,
    KEY_FILE: keyFile,
  })
  const handshakes = async (trusted: string): Promise<Set<string>> => {
    const seen = new Set<string>()
    for (let i = 0; i < 12; i++) {
      seen.add(
        await new Promise<string>((resolve, reject) => {
          const socket = tlsConnect({ port, host: "127.0.0.1", ca: trusted }, () => {
            const fingerprint = socket.getPeerCertificate().fingerprint256
            socket.destroy()
            resolve(fingerprint)
          })
          socket.on("error", reject)
        }),
      )
    }
    return seen
  }
  try {
    await run.nth("ready")
    assert.deepEqual([...(await handshakes(a.cert))], [new X509Certificate(a.cert).fingerprint256])
    await writeFile(certFile, b.cert)
    await writeFile(keyFile, b.key)
    run.child.kill("SIGHUP")
    await run.nth("reloaded")
    assert.deepEqual([...(await handshakes(b.cert))], [new X509Certificate(b.cert).fingerprint256])
  } finally {
    run.child.kill("SIGTERM")
    await run.exited
    await rm(dir, { recursive: true, force: true })
  }
})

test("a worker that replaces a dead one serves the reloaded certificate, not the entrypoint's", async () => {
  const [a, b] = [await selfSignedCertificate(), await selfSignedCertificate()]
  const dir = await mkdtemp(join(tmpdir(), "node-engine-cluster-inline-"))
  const files = {
    a: [join(dir, "a-cert.pem"), join(dir, "a-key.pem")],
    b: [join(dir, "b-cert.pem"), join(dir, "b-key.pem")],
  } as const
  await Promise.all([
    writeFile(files.a[0], a.cert),
    writeFile(files.a[1], a.key),
    writeFile(files.b[0], b.cert),
    writeFile(files.b[1], b.key),
  ])
  const port = await freePort()
  const run = new Run({
    PORT: String(port),
    WORKERS: "2",
    INLINE_CERT_FILE: files.a[0],
    INLINE_KEY_FILE: files.a[1],
    RELOAD_CERT_FILE: files.b[0],
    RELOAD_KEY_FILE: files.b[1],
  })
  const presented = async (trusted: string): Promise<Set<string>> => {
    const seen = new Set<string>()
    for (let i = 0; i < 16; i++) {
      seen.add(
        await new Promise<string>((resolve, reject) => {
          const socket = tlsConnect({ port, host: "127.0.0.1", ca: trusted }, () => {
            const fingerprint = socket.getPeerCertificate().fingerprint256
            socket.destroy()
            resolve(fingerprint)
          })
          socket.on("error", reject)
        }),
      )
    }
    return seen
  }
  try {
    const ready = await run.nth("ready")
    run.child.kill("SIGUSR1")
    await run.nth("reloaded-inline")
    const [victim] = pidsOf(ready)
    assert.ok(victim)
    process.kill(victim, "SIGKILL")
    await run.nth("listening", 3)
    assert.deepEqual([...(await presented(b.cert))], [new X509Certificate(b.cert).fingerprint256])
  } finally {
    run.child.kill("SIGTERM")
    await run.exited
    await rm(dir, { recursive: true, force: true })
  }
})

test("the first worker to fail ends the start even while a sibling is still starting", async () => {
  const port = await freePort()
  const run = new Run({ PORT: String(port), WORKERS: "2", FAIL_FIRST: "1" })
  assert.equal(await run.exited, 1)
  const failed = await run.nth("failed")
  assert.match(String(failed.message), /first worker refused/)
})

test("options a cluster cannot honour are refused up front", async () => {
  const app = () => ({ fetch: () => new Response("ok") })
  await assert.rejects(serveCluster(app, { port: 0 }), /fixed `port`/)
  await assert.rejects(serveCluster(app, { port: 4000, workers: 0 }), /positive integer/)
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("a rolling restart replaces every worker and the port keeps answering", async () => {
  const port = await freePort()
  const run = new Run({ PORT: String(port), WORKERS: "3" })
  try {
    const before = pidsOf(await run.nth("ready"))
    // A client that retries once, as one behind a load balancer does. Linux drops the connections
    // queued on a listener as it closes, so a first attempt may be reset; a second must not be.
    let unanswered = 0
    let answered = 0
    let running = true
    const attempt = async (): Promise<boolean> => {
      try {
        const reply = await fetch(`http://127.0.0.1:${port}/pid`, {
          headers: { connection: "close" },
          signal: AbortSignal.timeout(5000),
        })
        await reply.arrayBuffer()
        return reply.ok
      } catch {
        return false
      }
    }
    const traffic = (async () => {
      while (running) {
        let retried = await attempt()
        if (!retried) retried = await attempt()
        if (retried) answered++
        else unanswered++
      }
    })()
    run.child.kill("SIGUSR2")
    let restarted: Event
    try {
      restarted = await run.nth("restarted", 1, 30_000)
    } finally {
      running = false
      await traffic
    }
    const after = pidsOf(restarted)
    assert.equal(after.length, 3)
    for (const pid of after) assert.ok(!before.includes(pid), "a worker survived the restart")
    for (const pid of before) assert.ok(!alive(pid), "an old worker is still running")
    assert.ok(answered > 0)
    assert.equal(unanswered, 0, `${unanswered} requests failed twice during the restart`)
    assert.ok(await pidOf(port))
    // The replaced workers were retired, not mourned: nothing was respawned.
    assert.equal(run.events.filter((event) => event.respawning === true).length, 0)
  } finally {
    run.child.kill("SIGTERM")
    assert.equal(await run.exited, 0)
  }
})

test("a restart whose new worker cannot start leaves the old workers serving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "node-engine-restart-"))
  const breakFile = join(dir, "broken")
  const port = await freePort()
  const run = new Run({ PORT: String(port), WORKERS: "2", BREAK_FILE: breakFile })
  try {
    const before = pidsOf(await run.nth("ready"))
    await writeFile(breakFile, "")
    run.child.kill("SIGUSR2")
    const failed = await run.nth("restart-failed")
    assert.match(String(failed.message), /broken build/)
    for (const pid of before) assert.ok(alive(pid), "an old worker was stopped by a failed restart")
    assert.ok(await pidOf(port))
    await rm(breakFile)
    run.child.kill("SIGUSR2")
    const after = pidsOf(await run.nth("restarted", 1, 30_000))
    for (const pid of after) assert.ok(!before.includes(pid))
  } finally {
    run.child.kill("SIGTERM")
    assert.equal(await run.exited, 0)
    await rm(dir, { recursive: true, force: true })
  }
})

test("stopping the cluster during a restart leaves no worker behind", async () => {
  const port = await freePort()
  const run = new Run({ PORT: String(port), WORKERS: "3" })
  const seen = pidsOf(await run.nth("ready"))
  run.child.kill("SIGUSR2")
  await run.nth("listening", 4)
  run.child.kill("SIGTERM")
  assert.equal(await run.exited, 0)
  const everyone = [
    ...seen,
    ...run.events.filter((event) => event.event === "listening").map((event) => Number(event.pid)),
  ]
  for (const pid of everyone) assert.ok(!alive(pid), `worker ${pid} outlived the primary`)
})

test("explicit ticketKeys survive a cert-only reloadTls across live and replacement workers", async () => {
  const [a, b] = [await selfSignedCertificate(), await selfSignedCertificate()]
  const dir = await mkdtemp(join(tmpdir(), "node-engine-cluster-keys-"))
  const files = {
    a: [join(dir, "a-cert.pem"), join(dir, "a-key.pem")],
    b: [join(dir, "b-cert.pem"), join(dir, "b-key.pem")],
  } as const
  await Promise.all([
    writeFile(files.a[0], a.cert),
    writeFile(files.a[1], a.key),
    writeFile(files.b[0], b.cert),
    writeFile(files.b[1], b.key),
  ])
  const port = await freePort()
  const keyHex = randomBytes(48).toString("hex")
  const run = new Run({
    PORT: String(port),
    WORKERS: "2",
    INLINE_CERT_FILE: files.a[0],
    INLINE_KEY_FILE: files.a[1],
    RELOAD_CERT_FILE: files.b[0],
    RELOAD_KEY_FILE: files.b[1],
    TICKET_KEY_HEX: keyHex,
  })
  const resumeTicket = (
    trusted: string,
    session?: Buffer,
  ): Promise<{ reused: boolean; session: Buffer | undefined }> =>
    new Promise((resolve, reject) => {
      const tlsOpts: {
        port: number
        host: string
        ca: string
        maxVersion: "TLSv1.2"
        session?: Buffer
      } = {
        port,
        host: "127.0.0.1",
        ca: trusted,
        maxVersion: "TLSv1.2",
      }
      if (session !== undefined) tlsOpts.session = session
      const sock = tlsConnect(tlsOpts, () => {
        const out = { reused: sock.isSessionReused(), session: sock.getSession() }
        sock.destroy()
        resolve(out)
      })
      sock.on("error", reject)
    })
  try {
    const ready = await run.nth("ready")
    const before = await resumeTicket(a.cert)
    assert.ok(before.session)
    run.child.kill("SIGUSR1")
    await run.nth("reloaded-inline")

    // Issue a session under the reloaded cert on a live worker, then replace one worker and verify
    // resumption succeeds across both live and replacement workers.
    const issuedAfterReload = await resumeTicket(b.cert)
    assert.ok(issuedAfterReload.session)
    const [victim] = pidsOf(ready)
    assert.ok(victim)
    process.kill(victim, "SIGKILL")
    await run.nth("listening", 3)

    for (let i = 0; i < 8; i++) {
      const resumed = await resumeTicket(b.cert, issuedAfterReload.session)
      assert.equal(resumed.reused, true)
    }
  } finally {
    run.child.kill("SIGTERM")
    await run.exited
    await rm(dir, { recursive: true, force: true })
  }
})

test("sharedListener supports ephemeral port 0 and rolling restarts across workers", async () => {
  const run = new Run({ PORT: "0", WORKERS: "2", SHARED_LISTENER: "1" })
  try {
    const ready = await run.nth("ready")
    const port = ready.port
    assert.equal(typeof port, "number")
    if (typeof port !== "number") throw new Error("expected numeric port")
    assert.ok(port > 0)

    const before = pidsOf(ready)
    assert.equal(before.length, 2)
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/pid`)
      assert.equal(res.status, 200)
      const body: unknown = await res.json()
      const pid = typeof body === "object" && body !== null ? Reflect.get(body, "pid") : undefined
      assert.ok(typeof pid === "number" && before.includes(pid))
    }

    run.child.kill("SIGUSR2")
    const restarted = await run.nth("restarted")
    const after = pidsOf(restarted)
    assert.equal(after.length, 2)
    for (const oldPid of before) assert.ok(!after.includes(oldPid))

    const resAfter = await fetch(`http://127.0.0.1:${port}/pid`)
    assert.equal(resAfter.status, 200)
  } finally {
    run.child.kill("SIGTERM")
    await run.exited
  }
})
