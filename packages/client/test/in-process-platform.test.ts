import { expect, test } from "bun:test"
import { type BackendPlatformBinder, NIFRA_BACKEND_BIND_PLATFORM } from "@nifrajs/core/mount"
import { type Platform, server } from "@nifrajs/core/server"
import { inProcessClient, testClient } from "../src/client.ts"
import { ResponseContractViolation } from "../src/index.ts"

const app = server()
  .get("/who", (c) => ({
    ip: c.clientIp ?? null,
    env: (c.env as { region?: string } | undefined)?.region ?? null,
  }))
  .get(
    "/drifted",
    {
      response: {
        "~standard": {
          version: 1 as const,
          vendor: "test",
          validate: (value: unknown) =>
            typeof (value as { n?: unknown }).n === "number"
              ? { value: value as { n: number } }
              : { issues: [{ message: "n must be a number" }] },
        },
      },
    },
    () => ({ n: "x" }) as unknown as { n: number },
  )

const bindOf = (api: unknown): BackendPlatformBinder =>
  (api as { [NIFRA_BACKEND_BIND_PLATFORM]: BackendPlatformBinder })[NIFRA_BACKEND_BIND_PLATFORM]

test("a standalone in-process client dispatches with no platform; a test client is a local peer", async () => {
  expect((await inProcessClient<typeof app>(app).who.get()).data).toEqual({ ip: null, env: null })
  expect((await testClient<typeof app>(app).who.get()).data).toEqual({ ip: "127.0.0.1", env: null })
})

test("a platform-bound view carries that platform; the unbound client stays anonymous", async () => {
  const api = inProcessClient<typeof app>(app)
  const platform: Platform = { clientIp: "203.0.113.1", env: { region: "eu" } }
  const view = bindOf(api)(platform) as typeof api
  expect((await view.who.get()).data).toEqual({ ip: "203.0.113.1", env: "eu" })
  expect((await api.who.get()).data).toEqual({ ip: null, env: null })
  // Two views never share a platform.
  const other = bindOf(api)({ clientIp: "203.0.113.2" }) as typeof api
  const [a, b] = await Promise.all([view.who.get(), other.who.get()])
  expect(a.data).toEqual({ ip: "203.0.113.1", env: "eu" })
  expect(b.data).toEqual({ ip: "203.0.113.2", env: null })
})

test("a bound view keeps validateResponses", async () => {
  const api = testClient<typeof app>(app, { validateResponses: true })
  const view = bindOf(api)({ clientIp: "203.0.113.3" }) as typeof api
  expect((await view.who.get()).data).toEqual({ ip: "203.0.113.3", env: null })
  await expect(view.drifted.get()).rejects.toBeInstanceOf(ResponseContractViolation)
})
