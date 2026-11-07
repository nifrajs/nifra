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
