import {
  certifyAdapter,
  runtimeAdapterCertificationProfile,
} from "../../testing/src/certification.ts"
import { serve } from "../src/index.ts"

Deno.test("the Deno HTTP adapter satisfies the portable runtime certification profile", async () => {
  const report = await certifyAdapter({
    profile: runtimeAdapterCertificationProfile(),
    adapterId: "deno-http",
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
  if (!report.ok) throw new Error(`runtime certification failed: ${report.evidenceHash}`)
})
