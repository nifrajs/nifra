import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { server } from "@nifrajs/core"
import { type EngineServer, serve } from "../src/index.ts"

let running: EngineServer

const SAMPLES = ["héllo", "日本語", "tick 😀 tock", "plain ascii", "ÿ"]

before(async () => {
  const app = server()
    .get("/json", () => ({ samples: SAMPLES }))
    .get("/ascii", () => ({ samples: ["plain", "ascii"] }))
    .get(
      "/headed",
      () =>
        new Response(JSON.stringify({ samples: SAMPLES }), {
          headers: { "content-type": "application/json", "x-extra": "1" },
        }),
    )
    .post("/echo", async (c) => ({ echoed: await c.req.json() }))
  running = await serve(app, { port: 0, hostname: "127.0.0.1" })
})

after(() => running.stop())

const url = (path: string): string => `http://127.0.0.1:${running.port}${path}`

test("a JSON answer with non-ASCII text arrives byte for byte, with the right length", async () => {
  const res = await fetch(url("/json"))
  const bytes = new Uint8Array(await res.arrayBuffer())
  const expected = Buffer.from(JSON.stringify({ samples: SAMPLES }))
  assert.deepEqual(Buffer.from(bytes), expected)
  assert.equal(res.headers.get("content-length"), String(expected.byteLength))
})

test("an answer carrying its own headers is encoded the same way", async () => {
  const res = await fetch(url("/headed"))
  assert.equal(res.headers.get("x-extra"), "1")
  assert.deepEqual(await res.json(), { samples: SAMPLES })
})

test("non-ASCII JSON round-trips through a POST", async () => {
  const res = await fetch(url("/echo"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ samples: SAMPLES }),
  })
  assert.deepEqual(await res.json(), { echoed: { samples: SAMPLES } })
})

test("non-ASCII answers stay byte exact after a long run of ASCII ones", async () => {
  const expected = Buffer.from(JSON.stringify({ samples: SAMPLES }))
  for (let i = 0; i < 200; i++) await (await fetch(url("/ascii"))).arrayBuffer()
  for (let i = 0; i < 40; i++) {
    const res = await fetch(url("/json"))
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), expected)
    assert.equal(res.headers.get("content-length"), String(expected.byteLength))
  }
  for (let i = 0; i < 40; i++) {
    const res = await fetch(url(i % 2 === 0 ? "/ascii" : "/json"))
    const bytes = Buffer.from(await res.arrayBuffer())
    if (i % 2 === 1) assert.deepEqual(bytes, expected)
  }
})
