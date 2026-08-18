import { expect, test } from "bun:test"
import {
  certifyAdapter,
  runtimeAdapterCertificationProfile,
} from "../../testing/src/certification.ts"
import { server } from "../src/index.ts"

test("the Edge adapter satisfies the portable runtime certification profile", async () => {
  const report = await certifyAdapter({
    profile: runtimeAdapterCertificationProfile(),
    adapterId: "edge-fetch",
    createAdapter: () => ({
      async start(app) {
        // EdgeServer is the adapter under test; Bun only supplies the local network boundary that
        // makes the portable request/response profile observable over HTTP.
        const edge = server()
          .post("/cert/path", (context) => app.fetch(context.request))
          .get("/", (context) => app.fetch(context.request))
        const running = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: edge.fetch })
        return {
          origin: `http://127.0.0.1:${running.port}`,
          stop: () => running.stop(true),
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
