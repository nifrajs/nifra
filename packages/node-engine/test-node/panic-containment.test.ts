/**
 * A panic in the engine stays on the request that raised it. Needs the `fault-injection` build of
 * the addon, so it is skipped unless `NIFRA_ENGINE_FAULT_ADDON` names one.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { server } from "@nifrajs/core"
import { parseHead, raw } from "./support.ts"

const addon = process.env.NIFRA_ENGINE_FAULT_ADDON
const options = { skip: addon === undefined, timeout: 20_000 }

const get = (path: string, extra = ""): string =>
  `GET ${path} HTTP/1.1\r\nHost: h\r\nConnection: close\r\n${extra}\r\n`

test(
  "a panic closes its connection or fails its request, and the server keeps serving",
  options,
  async () => {
    process.env.NIFRA_RUST_ENGINE_PATH = addon
    const { serve } = await import("../src/index.ts")
    const app = server()
      .get("/ok", () => ({ ok: true }))
      .get("/header", (c) => ({ value: c.req.headers.get("x-nifra-panic") }))
    const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
    const status = async (request: string) =>
      parseHead(await raw(running.port, request, () => false))
    try {
      for (let i = 0; i < 20; i++) {
        // A panic while the engine parses: only that connection is closed.
        assert.equal(await raw(running.port, "PANIC / HTTP/1.1\r\n\r\n", () => false), "")
        assert.equal((await status(get("/ok"))).status, 200)
        // A panic inside a call from JavaScript: the call throws and the request fails.
        assert.equal((await status(get("/header", "x-nifra-panic: 1\r\n"))).status, 500)
        assert.equal((await status(get("/ok"))).status, 200)
      }
    } finally {
      await running.stop({ drainMs: 0 })
    }
  },
)
