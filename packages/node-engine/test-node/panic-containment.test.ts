/**
 * A panic in the engine stays on the request that raised it. Needs the `fault-injection` build of
 * the addon, so it is skipped unless `NIFRA_ENGINE_FAULT_ADDON` names one.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { server } from "@nifrajs/core"
import { parseHead, raw, rawExchange } from "./support.ts"

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
        const panicked = await rawExchange(running.port, "PANIC / HTTP/1.1\r\n\r\n")
        assert.deepEqual(panicked, { received: "", end: "closed" })
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

test(
  "a panic behind an async answer costs only that request, even when the logger throws",
  options,
  async () => {
    process.env.NIFRA_RUST_ENGINE_PATH = addon
    const { serve } = await import("../src/index.ts")
    // Both handlers answer in the same microtask checkpoint, so their slots share one flush.
    let waiting = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const arrive = async () => {
      waiting += 1
      if (waiting === 2) release()
      await gate
    }
    const refuse = () => {
      throw new Error("logger")
    }
    const app = server({ logger: { debug: refuse, info: refuse, warn: refuse, error: refuse } })
      .get("/ok", () => ({ ok: true }))
      // The fault build refuses to prepare a template for status 299.
      .get("/prepare", async (c) => {
        await Promise.resolve()
        c.set.status = 299
        return { ok: true }
      })
      .get("/flush", async (c) => {
        await arrive()
        c.set.headers["x-nifra-panic-flush"] = "1"
        return { ok: true }
      })
      .get("/beside", async () => {
        await arrive()
        return { ok: true }
      })
    const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
    try {
      const prepare = await raw(running.port, get("/prepare"))
      assert.equal(parseHead(prepare).status, 500)

      const flushed = rawExchange(running.port, get("/flush"))
      while (waiting === 0) await new Promise((resolve) => setImmediate(resolve))
      const beside = raw(running.port, get("/beside"))
      assert.deepEqual(await flushed, { received: "", end: "closed" })
      assert.equal(parseHead(await beside).status, 200)
      assert.equal(parseHead(await raw(running.port, get("/ok"))).status, 200)
    } finally {
      await running.stop({ drainMs: 0 })
    }
  },
)
