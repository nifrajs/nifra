/**
 * Static files served through the Node-stream claim, on **Node itself**.
 *
 * A static response body is a `FileHandle` read stream. When the writer claims it, the bytes go to
 * the socket without the Web reader loop ever touching them - which also means nothing in that loop
 * is around to end the stream, and the file descriptor's fate rides entirely on the claimed path
 * destroying it. An fd leak here is invisible per request and fatal after a few thousand, so it is
 * asserted directly rather than inferred.
 *
 * Node lane because that is where the claim actually fires and where `/dev/fd` reflects the process.
 */

import assert from "node:assert/strict"
import { readdirSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"

const CONTENT = Buffer.alloc(64 * 1024, 7)

let dir = ""
let port = 0
let stop: (() => Promise<void>) | undefined

const openFds = (): number => readdirSync("/dev/fd").length

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "nifra-static-claim-"))
  await writeFile(join(dir, "asset.bin"), CONTENT)
  const app = server().get("/", () => "root")
  const handle = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    static: { dir, prefix: "/assets" },
  })
  port = handle.port
  stop = () => handle.stop()
})

after(async () => {
  await stop?.()
  await rm(dir, { recursive: true, force: true })
})

test("a claimed static body is served whole", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/assets/asset.bin`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-length"), String(CONTENT.length))
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.length, CONTENT.length)
  assert.equal(bytes.equals(CONTENT), true)
})

test("serving the same file many times does not leak file descriptors", async () => {
  // Warm first: the first requests open sockets and pool entries that are not the fd under test.
  for (let i = 0; i < 30; i++) {
    await fetch(`http://127.0.0.1:${port}/assets/asset.bin`).then((r) => r.arrayBuffer())
  }
  const before = openFds()
  for (let i = 0; i < 300; i++) {
    await fetch(`http://127.0.0.1:${port}/assets/asset.bin`).then((r) => r.arrayBuffer())
  }
  // One leaked descriptor per request would be +300; the slack is for sockets in TIME_WAIT.
  const growth = openFds() - before
  assert.ok(growth < 40, `open descriptors grew by ${growth} over 300 static requests`)
})

test("a client that abandons a static response mid-body does not leak either", async () => {
  const before = openFds()
  for (let i = 0; i < 100; i++) {
    const abort = new AbortController()
    const pending = fetch(`http://127.0.0.1:${port}/assets/asset.bin`, { signal: abort.signal })
    await pending
      .then((r) => {
        const reader = r.body!.getReader()
        return reader.read().then(() => abort.abort())
      })
      .catch(() => undefined)
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
  const growth = openFds() - before
  assert.ok(growth < 40, `open descriptors grew by ${growth} over 100 abandoned static requests`)
})
