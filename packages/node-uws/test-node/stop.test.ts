import assert from "node:assert/strict"
import { connect } from "node:net"
import { afterEach, test } from "node:test"
import { server } from "@nifrajs/core"
import { serve as serveUws } from "../src/index.ts"
import { sleep } from "./support.ts"

const open: Array<Awaited<ReturnType<typeof serveUws>>> = []
async function serve(
  ...args: Parameters<typeof serveUws>
): Promise<Awaited<ReturnType<typeof serveUws>>> {
  const handle = await serveUws(...args)
  open.push(handle)
  return handle
}

afterEach(async () => {
  for (const handle of open.splice(0)) await handle.stop({ drainMs: 0 })
})

test("stop() lets an in-flight request finish, refuses new connections, and runs the lifecycle hooks in order", async () => {
  const events: string[] = []
  const app = server()
    .onStopping(() => {
      events.push("stopping")
    })
    .onStop(() => {
      events.push("stopped")
    })
    .get("/slow", async () => {
      await sleep(150)
      events.push("handled")
      return { slow: true }
    })
  const handle = await serve(app, { port: 0, hostname: "127.0.0.1" })
  const inFlight = fetch(`http://127.0.0.1:${handle.port}/slow`)
  await sleep(30)
  const stopping = handle.stop({ drainMs: 3000 })
  const response = await inFlight
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { slow: true })
  await stopping
  assert.deepEqual(events, ["stopping", "handled", "stopped"])
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = connect(handle.port, "127.0.0.1", () => resolve(undefined))
      socket.on("error", reject)
    }),
  )
})

test("stop() is idempotent and await using waits for the shutdown under way", async () => {
  let stops = 0
  const app = server().onStop(() => {
    stops++
  })
  const handle = await serve(app, { port: 0, hostname: "127.0.0.1" })
  const first = handle.stop({ drainMs: 0 })
  await Promise.all([first, handle.stop(), handle[Symbol.asyncDispose]()])
  assert.equal(stops, 1)
})

test("a request that outlives drainMs is closed at the deadline", async () => {
  const app = server().get("/never", () => new Promise<never>(() => {}))
  const handle = await serve(app, { port: 0, hostname: "127.0.0.1" })
  const request = fetch(`http://127.0.0.1:${handle.port}/never`).catch((error: unknown) => error)
  await sleep(30)
  const started = Date.now()
  await handle.stop({ drainMs: 120 })
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 100 && elapsed < 1500, `stopped after ${elapsed}ms`)
  assert.ok((await request) instanceof Error)
})

test("delayMs keeps serving until the delay is over", async () => {
  const app = server().get("/ping", () => ({ pong: true }))
  const handle = await serve(app, { port: 0, hostname: "127.0.0.1" })
  const stopping = handle.stop({ drainMs: 0, delayMs: 120 })
  await sleep(30)
  const during = await fetch(`http://127.0.0.1:${handle.port}/ping`)
  assert.equal(during.status, 200)
  await during.text()
  await stopping
})

test("an idle keep-alive connection does not hold stop() back", async () => {
  const app = server().get("/ping", () => ({ pong: true }))
  const handle = await serve(app, { port: 0, hostname: "127.0.0.1" })
  const socket = connect(handle.port, "127.0.0.1")
  await new Promise((resolve) => socket.once("connect", resolve))
  socket.write("GET /ping HTTP/1.1\r\nHost: x\r\n\r\n")
  await new Promise((resolve) => socket.once("data", resolve))
  const started = Date.now()
  await handle.stop({ drainMs: 5000 })
  assert.ok(Date.now() - started < 1500)
  socket.destroy()
})

test("a second stop() resolves only when the shutdown under way has finished", async () => {
  const events: string[] = []
  const app = server()
    .onStopping(async () => {
      await sleep(80)
      events.push("stopping")
    })
    .onStop(() => {
      events.push("stopped")
    })
  const handle = await serve(app, { port: 0, hostname: "127.0.0.1" })
  const first = handle.stop({ drainMs: 0 })
  await sleep(10)
  await handle.stop()
  assert.deepEqual(events, ["stopping", "stopped"])
  await first
})
