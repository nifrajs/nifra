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
