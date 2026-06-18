import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { server } from "@nifrajs/core"
import { type NodeServer, serve } from "../src/index.ts"

let dir = ""
let running: NodeServer | undefined

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nifra-static-"))
  await writeFile(join(dir, "app.js"), "console.log('hi')")
  await writeFile(join(dir, "style.css"), "body{}")
  await writeFile(join(dir, "large.txt"), "x".repeat(256 * 1024))
})
afterEach(async () => {
  await running?.stop({ drainMs: 0 })
  running = undefined
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const app = server().get("/", () => ({ page: true }))

async function startWithStatic(prefix?: string): Promise<string> {
  running = await serve(app, { port: 0, static: { dir, ...(prefix ? { prefix } : {}) } })
  return `http://127.0.0.1:${running.port}`
}

test("serves a static file with content-type + immutable cache", async () => {
  const base = await startWithStatic()
  const res = await fetch(`${base}/assets/app.js`)
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
  expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  expect(await res.text()).toBe("console.log('hi')")
})

test("infers content-type per extension (css)", async () => {
  const base = await startWithStatic()
  const res = await fetch(`${base}/assets/style.css`)
  expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8")
})

test("a missing file under the prefix is a 404 (not the app's 404 page)", async () => {
  const base = await startWithStatic()
  const res = await fetch(`${base}/assets/missing.js`)
  expect(res.status).toBe(404)
})

test("non-prefix paths fall through to the app (fast path intact)", async () => {
  const base = await startWithStatic()
  const res = await fetch(`${base}/`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ page: true })
})

test("path traversal out of the served dir is rejected (403)", async () => {
  const base = await startWithStatic()
  // `%2e%2e%2f` = `../` — survives URL normalization, decoded only after the prefix is stripped.
  const res = await fetch(`${base}/assets/%2e%2e%2fsecret.txt`)
  expect(res.status).toBe(403)
})

test("HEAD returns headers + content-length, no body", async () => {
  const base = await startWithStatic()
  const res = await fetch(`${base}/assets/app.js`, { method: "HEAD" })
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
  expect(res.headers.get("content-length")).toBe(String("console.log('hi')".length))
  expect(await res.text()).toBe("")
})

test("query strings are ignored when resolving the file", async () => {
  const base = await startWithStatic()
  const res = await fetch(`${base}/assets/app.js?v=abc123`)
  expect(res.status).toBe(200)
})

test("serves large static files with content-length", async () => {
  const base = await startWithStatic()
  const res = await fetch(`${base}/assets/large.txt`)
  expect(res.status).toBe(200)
  expect(res.headers.get("content-length")).toBe(String(256 * 1024))
  expect((await res.text()).length).toBe(256 * 1024)
})

// Cleanup the temp dir last (afterEach handles servers; this removes the fixture).
test("cleanup", async () => {
  await rm(dir, { recursive: true, force: true })
  expect(true).toBe(true)
})
