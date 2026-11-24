import assert from "node:assert/strict"
import { test } from "node:test"
import { server } from "@nifrajs/core"
import { serve } from "../src/index.ts"
import { parseHead, raw } from "./support.ts"

const app = () =>
  server()
    .get("/u", () => ({ ok: true }))
    .get("/v", (c) => ({ url: c.req.url }))

const get = async (
  port: number,
  host: string,
  path = "/u",
): Promise<{ status: number; body: string }> => {
  const { status, body } = parseHead(
    await raw(
      port,
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      (r) => r.includes("}") || r.includes("Bad Request"),
    ),
  )
  return { status, body }
}

test("by default Host is left to the engine and to req.url", async () => {
  const running = await serve(app(), { port: 0, hostname: "127.0.0.1" })
  try {
    assert.equal((await get(running.port, "example.test:99999")).status, 200)
    const ok = await get(running.port, "Example.TEST:8080", "/v")
    assert.equal(ok.status, 200)
    assert.equal(JSON.parse(ok.body).url, "http://example.test:8080/v")
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("validateHost: true refuses a malformed Host and normalizes a valid one", async () => {
  const running = await serve(app(), { port: 0, hostname: "127.0.0.1", validateHost: true })
  try {
    assert.equal((await get(running.port, "example.test:99999")).status, 400)
    const ok = await get(running.port, "Example.TEST", "/v")
    assert.equal(ok.status, 200)
    assert.equal(JSON.parse(ok.body).url, "http://example.test/v")
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a Host policy turns the check on", async () => {
  const running = await serve(app(), {
    port: 0,
    hostname: "127.0.0.1",
    allowedHosts: ["example.test"],
  })
  try {
    assert.equal((await get(running.port, "example.test:99999")).status, 400)
    assert.equal((await get(running.port, "example.test")).status, 200)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("validateHost takes a boolean and not alongside a Host policy", () => {
  const base = { port: 0, hostname: "127.0.0.1" }
  assert.throws(() => serve(app(), { ...base, validateHost: 0 as never }), TypeError)
  assert.throws(
    () => serve(app(), { ...base, validateHost: false, allowedHosts: ["example.test"] }),
    TypeError,
  )
  assert.throws(
    () => serve(app(), { ...base, validateHost: false, canonicalHost: "example.test" }),
    TypeError,
  )
})
