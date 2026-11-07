import { expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { serve } from "../src/index.ts"

test("await using a serve() handle runs the app's stop hooks when the scope ends", async () => {
  const log: string[] = []
  const app = server()
    .get("/", () => "ok")
    .onStop(() => {
      log.push("stopped")
    })
  {
    await using running = await serve(app, { hostname: "127.0.0.1", port: 0 })
    const response = await fetch(`http://127.0.0.1:${running.port}/`)
    expect(response.status).toBe(200)
    expect(log).toEqual([])
  }
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
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  const stopping = running.stop()
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
