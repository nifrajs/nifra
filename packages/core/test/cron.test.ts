import { describe, expect, test } from "bun:test"
import { type ScheduledController, server, toFetchHandler } from "../src/index.ts"

function controller(): ScheduledController {
  return { scheduledTime: 1_700_000_000_000, cron: "0 * * * *", noRetry() {} }
}

describe("toFetchHandler scheduled passthrough", () => {
  test("without options: fetch only, no scheduled", () => {
    const handler = toFetchHandler(server().get("/", () => ({ ok: true })))
    expect(typeof handler.fetch).toBe("function")
    expect(handler.scheduled).toBeUndefined()
  })

  test("fetch still threads env + waitUntil into the app", async () => {
    const app = server<{ TAG: string }>().get("/", (c) => ({ tag: c.env.TAG }))
    const res = await toFetchHandler(app).fetch(
      new Request("http://t/"),
      { TAG: "hi" },
      {
        waitUntil() {},
      },
    )
    expect(await res.json()).toEqual({ tag: "hi" })
  })

  test("scheduled receives the controller + typed env + a working waitUntil", async () => {
    const app = server<{ TAG: string }>().get("/", () => ({ ok: true }))
    let seen: { time: number; cron: string; tag: string } | undefined
    const waited: Promise<unknown>[] = []
    const handler = toFetchHandler(app, {
      scheduled: (ctrl, { env, waitUntil }) => {
        seen = { time: ctrl.scheduledTime, cron: ctrl.cron, tag: env.TAG }
        waitUntil(Promise.resolve())
      },
    })
    expect(typeof handler.scheduled).toBe("function")
    await handler.scheduled?.(controller(), { TAG: "x" }, { waitUntil: (p) => void waited.push(p) })
    expect(seen).toEqual({ time: 1_700_000_000_000, cron: "0 * * * *", tag: "x" })
    expect(waited).toHaveLength(1)
  })

  test("an async scheduled handler is awaited", async () => {
    let done = false
    const handler = toFetchHandler(server(), {
      scheduled: async () => {
        await Promise.resolve()
        done = true
      },
    })
    await handler.scheduled?.(controller(), {}, { waitUntil() {} })
    expect(done).toBe(true)
  })
})
