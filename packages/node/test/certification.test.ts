import { expect, test } from "bun:test"
import {
  certifyAdapter,
  runtimeAdapterCertificationProfile,
} from "../../testing/src/certification.ts"
import { serve } from "../src/index.ts"

test("the Node HTTP adapter satisfies the portable runtime certification profile", async () => {
  const report = await certifyAdapter({
    profile: runtimeAdapterCertificationProfile(),
    adapterId: "node-http",
    createAdapter: () => ({
      async start(app) {
        const server = await serve(app, { port: 0, hostname: "127.0.0.1" })
        return {
          origin: `http://127.0.0.1:${server.port}`,
          stop: () => server.stop(),
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
