import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { healthcheck } from "@nifrajs/middleware"

describe("healthcheck()", () => {
  test("/health is a flat 200 with no-store", async () => {
    const app = server().use(healthcheck())
    const res = await app.fetch(new Request("http://x/health"))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ status: "ok" })
  })

  test("/ready is 200 with no checks", async () => {
    const app = server().use(healthcheck())
    const res = await app.fetch(new Request("http://x/ready"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok", checks: {} })
  })

  test("/ready reports each check and is 200 when all pass", async () => {
    const app = server().use(healthcheck({ checks: { db: () => true, cache: async () => true } }))
    const res = await app.fetch(new Request("http://x/ready"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok", checks: { db: true, cache: true } })
  })

  test("/ready is 503 when a check fails or throws", async () => {
    const app = server().use(
      healthcheck({
        checks: {
          ok: () => true,
          down: () => false,
          boom: () => {
            throw new Error("unreachable")
          },
        },
      }),
    )
    const res = await app.fetch(new Request("http://x/ready"))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      status: "error",
      checks: { ok: true, down: false, boom: false },
    })
  })

  test("honors custom paths", async () => {
    const app = server().use(healthcheck({ path: "/livez", readyPath: "/readyz" }))
    expect((await app.fetch(new Request("http://x/livez"))).status).toBe(200)
    expect((await app.fetch(new Request("http://x/readyz"))).status).toBe(200)
  })
})
