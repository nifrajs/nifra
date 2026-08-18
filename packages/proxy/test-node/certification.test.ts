import assert from "node:assert/strict"
import test from "node:test"
import { server as nifraServer } from "@nifrajs/core"
import { serve } from "@nifrajs/node"
import { createProxy } from "@nifrajs/proxy"
import { undiciTransport } from "@nifrajs/proxy/undici"
import { certifyAdapter, runtimeAdapterCertificationProfile } from "@nifrajs/testing/certification"

test("the Node proxy transport satisfies the portable runtime certification profile", async () => {
  const report = await certifyAdapter({
    profile: runtimeAdapterCertificationProfile(),
    adapterId: "proxy-node-undici",
    createAdapter: async () => ({
      async start(app) {
        const upstream = await serve(app, { hostname: "127.0.0.1", port: 0 })
        const proxy = createProxy({
          upstream: `http://127.0.0.1:${upstream.port}`,
          transport: undiciTransport(),
        })
        const running = await serve(nifraServer().mountFetch("/", proxy), {
          hostname: "127.0.0.1",
          port: 0,
        })
        let stopped = false
        return {
          origin: `http://127.0.0.1:${running.port}`,
          stop: async () => {
            if (stopped) return
            stopped = true
            await running.stop()
            await upstream.stop()
          },
        }
      },
    }),
  })
  assert.equal(report.ok, true, `certification failed: ${JSON.stringify(report, null, 2)}`)
})
