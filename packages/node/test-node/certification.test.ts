/**
 * The Node adapter, exercised on **Node itself**.
 *
 * `packages/node/test` runs under Bun, which proves the adapter's logic but not that it works on the
 * runtime it exists for: Bun and Node differ exactly where an HTTP adapter lives - stream semantics,
 * `node:` builtin behaviour, socket teardown. A regression that only shows up on Node would ship
 * silently, which is why this file exists alongside the Bun suite rather than replacing it.
 *
 * Written against `node:test` + `node:assert` for the same reason `packages/deno/test` is written
 * against `Deno.test`: the native runner, no extra dependency, no shim to disagree with.
 *
 * Imports resolve by PACKAGE NAME, not by relative source path, so Node picks the `default` export
 * condition and loads `dist` - the bytes an installed Node user actually runs. Requires a build
 * first, matching the Deno job.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { serve } from "@nifrajs/node"
import { certifyAdapter, runtimeAdapterCertificationProfile } from "@nifrajs/testing/certification"

test("the Node HTTP adapter satisfies the portable runtime certification profile on Node", async () => {
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
  assert.equal(report.ok, true, `certification failed: ${JSON.stringify(report, null, 2)}`)
  assert.deepEqual(
    report.capabilities.map((capability) => capability.capability),
    ["request-bridge", "response-bridge", "lifecycle"],
  )
})
