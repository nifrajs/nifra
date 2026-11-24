import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { server } from "@nifrajs/core"
import { type EngineServer, serve } from "../src/index.ts"
import { parseHead, raw } from "./support.ts"

const app = () =>
  server()
    .get("/q", (c) => ({ url: c.req.url }))
    .post("/len", () => ({ ok: true }))

let plain: EngineServer
let normalizing: EngineServer

before(async () => {
  plain = await serve(app(), {
    port: 0,
    hostname: "127.0.0.1",
    maxBodySize: 100,
    oversizeWindow: 50,
  })
  normalizing = await serve(app(), { port: 0, hostname: "127.0.0.1", normalizeTarget: true })
})

after(async () => {
  await plain.stop()
  await normalizing.stop()
})

const get = async (port: number, target: string): Promise<{ url: string }> => {
  const { body } = parseHead(
    await raw(
      port,
      `GET ${target} HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n`,
      (r) => r.includes("}"),
    ),
  )
  return JSON.parse(body)
}

test("the query reaches the app with and without one", async () => {
  assert.deepEqual(await get(plain.port, "/q?a=1&b=2"), {
    url: "http://example.test/q?a=1&b=2",
  })
  assert.deepEqual(await get(plain.port, "/q"), { url: "http://example.test/q" })
})

test("an absolute-form target routes by its path and keeps its query", async () => {
  assert.deepEqual(await get(plain.port, "http://elsewhere.test/q?a=3"), {
    url: "http://example.test/q?a=3",
  })
})

test("a normalized target keeps its query", async () => {
  assert.deepEqual(await get(normalizing.port, "/x/../q?z=1"), {
    url: "http://example.test/q?z=1",
  })
})

const post = async (length: number): Promise<number> => {
  const head = `POST /len HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n`
  const { status } = parseHead(
    await raw(plain.port, head + "x".repeat(length), (r) => r.includes("\r\n\r\n")),
  )
  return status
}

test("the size cap compares the declared length exactly", async () => {
  assert.equal(await post(100), 200)
  assert.equal(await post(101), 413)
})
