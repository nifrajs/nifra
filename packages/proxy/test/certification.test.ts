import { expect, test } from "bun:test"
import {
  certifyAdapter,
  runtimeAdapterCertificationProfile,
} from "../../testing/src/certification.ts"
import { createProxy } from "../src/index.ts"

test("the networked proxy adapter satisfies the portable runtime certification profile", async () => {
  const report = await certifyAdapter({
    profile: runtimeAdapterCertificationProfile(),
    adapterId: "proxy-fetch",
    createAdapter: () => ({
      async start(app) {
        const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
        const proxy = createProxy({ upstream: `http://127.0.0.1:${upstream.port}` })
        const running = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: (request) => proxy(request),
        })
        let stopped = false
        return {
          origin: `http://127.0.0.1:${running.port}`,
          stop: async () => {
            if (stopped) return
            stopped = true
            await Promise.all([running.stop(true), upstream.stop(true)])
          },
        }
      },
    }),
  })
  expect(report.ok).toBe(true)
  expect(report.capabilities.map((capability) => capability.capability)).toEqual([
    "request-bridge",
    "response-bridge",
    "lifecycle",
  ])
})
