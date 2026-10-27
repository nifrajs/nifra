/**
 * `c.req.signal` on Node: it aborts when the client leaves, reading it builds no undici `Request`, and
 * a request built after it was read follows it.
 */

import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"

const NativeRequest = globalThis.Request
let built = 0
class CountedRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init)
    built++
  }
}

const gate = <T = void>() => {
  let open!: (value: T) => void
  const opened = new Promise<T>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

let started = gate()
let left = gate<{ aborted: boolean; same: boolean }>()
let base = ""
let stop: (() => Promise<void>) | undefined

const aborted = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))

before(async () => {
  const app = server()
    .get("/signal", (c) => {
      const before = built
      const signal = c.req.signal
      return { built: built - before, aborted: signal.aborted, same: signal === c.req.signal }
    })
    .get("/clone", (c) => {
      const before = built
      c.req.clone()
      return { built: built - before }
    })
    .post("/signal-then-body", async (c) => {
      const signal = c.req.signal
      const text = await c.req.text()
      return { text, same: signal === c.req.signal }
    })
    .get("/wait", async (c) => {
      const signal = c.req.signal
      started.open()
      await aborted(signal)
      left.open({ aborted: signal.aborted, same: signal === c.req.signal })
      return { ok: true }
    })
    .get("/wait-built", async (c) => {
      const signal = c.req.signal
      const copy = c.req.clone()
      started.open()
      await aborted(copy.signal)
      left.open({ aborted: copy.signal.aborted, same: signal === c.req.signal })
      return { ok: true }
    })
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  base = `http://127.0.0.1:${running.port}`
  stop = running.stop
  globalThis.Request = CountedRequest
})

after(async () => {
  globalThis.Request = NativeRequest
  await stop?.()
})

test("reading the signal builds no undici Request", async () => {
  const response = await fetch(`${base}/signal`)
  assert.deepEqual(await response.json(), { built: 0, aborted: false, same: true })
})

test("a member the lazy request does not serve itself builds one", async () => {
  const response = await fetch(`${base}/clone`)
  assert.deepEqual(await response.json(), { built: 1 })
})

test("the body still reads after the signal", async () => {
  const response = await fetch(`${base}/signal-then-body`, { method: "POST", body: "hello" })
  assert.deepEqual(await response.json(), { text: "hello", same: true })
})

for (const path of ["/wait", "/wait-built"]) {
  test(`${path}: the signal aborts when the client leaves`, async () => {
    started = gate()
    left = gate()
    const client = new AbortController()
    const request = fetch(`${base}${path}`, { signal: client.signal }).catch(() => undefined)
    await started.opened
    client.abort()
    assert.deepEqual(await left.opened, { aborted: true, same: true })
    await request
  })
}
