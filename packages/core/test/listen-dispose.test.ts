import { expect, test } from "bun:test"
import { server } from "../src/index.ts"

test("await using a listen() handle runs the app's graceful stop when the scope ends", async () => {
  const log: string[] = []
  const app = server()
    .get("/", () => "ok")
    .onStopping(() => {
      log.push("stopping")
    })
    .onStop(() => {
      log.push("stopped")
    })
  {
    await using running = app.listen(0, { hostname: "127.0.0.1" })
    const response = await fetch(`http://127.0.0.1:${running.port}/`)
    expect(response.status).toBe(200)
    expect(log).toEqual([])
  }
  expect(log).toEqual(["stopping", "stopped"])
})

test("disposing a handle that was already stopped is a no-op", async () => {
  const log: string[] = []
  const app = server().onStop(() => {
    log.push("stopped")
  })
  const running = app.listen(0, { hostname: "127.0.0.1" })
  await app.stop()
  await running[Symbol.asyncDispose]()
  expect(log).toEqual(["stopped"])
})

test("disposing during a shutdown that is under way waits for it", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const log: string[] = []
  const app = server()
    .onStopping(async () => {
      await gate
    })
    .onStop(() => {
      log.push("stopped")
    })
  const running = app.listen(0, { hostname: "127.0.0.1" })
  const stopping = app.stop()
  const disposed = running[Symbol.asyncDispose]()
  try {
    expect(await Promise.race([disposed.then(() => "done"), Promise.resolve("pending")])).toBe(
      "pending",
    )
    expect(log).toEqual([])
  } finally {
    release()
  }
  await disposed
  await stopping
  expect(log).toEqual(["stopped"])
})

test("disposing an earlier handle leaves a later listener serving", async () => {
  const app = server().get("/", () => ({ ok: true }))
  const first = app.listen(0, { hostname: "127.0.0.1" })
  const second = app.listen(0, { hostname: "127.0.0.1" })
  try {
    await first[Symbol.asyncDispose]()
    const response = await fetch(`http://127.0.0.1:${second.port}/`)
    expect(response.status).toBe(200)
  } finally {
    await second[Symbol.asyncDispose]()
    first.stop(true)
  }
})
