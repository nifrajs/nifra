import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { server } from "@nifrajs/core"
import { type NodeServer, type ServeStaticOptions, serve } from "../src/index.ts"

let dir = ""
let running: NodeServer | undefined

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nifra-static-"))
  await writeFile(join(dir, "app.js"), "console.log('hi')")
  await writeFile(join(dir, "style.css"), "body{}")
  await writeFile(join(dir, "large.txt"), "x".repeat(256 * 1024))
  await writeFile(join(dir, "logo..png"), "dotdot")
  await writeFile(join(dir, ".env"), "SECRET=hunter2")
  await mkdir(join(dir, ".git"))
  await writeFile(join(dir, ".git", "config"), "[core]")
  await mkdir(join(dir, ".hidden"))
  await writeFile(join(dir, ".hidden", "app.js"), "hidden")
})
afterEach(async () => {
  await running?.stop({ drainMs: 0 })
  running = undefined
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const app = server().get("/", () => ({ page: true }))

async function startWithStatic(
  prefix?: string,
  extra?: Partial<ServeStaticOptions>,
): Promise<string> {
  running = await serve(app, {
    hostname: "127.0.0.1",
    port: 0,
    static: { dir, ...(prefix ? { prefix } : {}), ...extra },
  })
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

test("revalidation answers 304 from If-None-Match or If-Modified-Since", async () => {
  const base = await startWithStatic()
  const first = await fetch(`${base}/assets/app.js`)
  const etag = first.headers.get("etag")
  const lastModified = first.headers.get("last-modified")
  expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/)
  expect(lastModified).not.toBeNull()
  expect(first.headers.get("accept-ranges")).toBe("bytes")
  await first.arrayBuffer()

  const byEtag = await fetch(`${base}/assets/app.js`, {
    headers: { "if-none-match": `"stale", W/${etag}` },
  })
  expect(byEtag.status).toBe(304)
  expect(byEtag.headers.get("etag")).toBe(etag)
  expect(await byEtag.text()).toBe("")

  const byDate = await fetch(`${base}/assets/app.js`, {
    headers: { "if-modified-since": lastModified ?? "" },
  })
  expect(byDate.status).toBe(304)

  // If-None-Match wins: a mismatched tag sends the file even with a current If-Modified-Since.
  const changed = await fetch(`${base}/assets/app.js`, {
    headers: { "if-none-match": '"other"', "if-modified-since": lastModified ?? "" },
  })
  expect(changed.status).toBe(200)
  expect(await changed.text()).toBe("console.log('hi')")

  const older = await fetch(`${base}/assets/app.js`, {
    headers: { "if-modified-since": new Date(0).toUTCString() },
  })
  expect(older.status).toBe(200)
  await older.arrayBuffer()
})

test("custom validator headers drive revalidation and ranges", async () => {
  const lastModified = "Wed, 01 Jan 2020 00:00:00 GMT"
  const base = await startWithStatic(undefined, {
    // Header names are case-insensitive; these common canonical spellings must override defaults.
    headers: { ETag: '"custom"', "Last-Modified": lastModified },
  })
  const first = await fetch(`${base}/assets/app.js`)
  expect(first.headers.get("etag")).toBe('"custom"')
  expect(first.headers.get("last-modified")).toBe(lastModified)
  await first.arrayBuffer()

  const byTag = await fetch(`${base}/assets/app.js`, {
    headers: { "if-none-match": 'W/"custom"' },
  })
  expect(byTag.status).toBe(304)

  const byDate = await fetch(`${base}/assets/app.js`, {
    headers: { "if-modified-since": lastModified },
  })
  expect(byDate.status).toBe(304)

  for (const validator of ['"custom"', lastModified]) {
    const range = await fetch(`${base}/assets/app.js`, {
      headers: { range: "bytes=0-6", "if-range": validator },
    })
    expect(range.status).toBe(206)
    expect(await range.text()).toBe("console")
  }

  // A date If-Range is an exact match, not a freshness check: a later date is a different validator.
  const later = await fetch(`${base}/assets/app.js`, {
    headers: { range: "bytes=0-6", "if-range": "Thu, 02 Jan 2020 00:00:00 GMT" },
  })
  expect(later.status).toBe(200)
  expect(await later.text()).toBe("console.log('hi')")
})

test("a weak custom ETag revalidates but never satisfies If-Range", async () => {
  const base = await startWithStatic(undefined, { headers: { ETag: 'W/"custom"' } })
  const revalidated = await fetch(`${base}/assets/app.js`, {
    headers: { "if-none-match": '"custom"' },
  })
  expect(revalidated.status).toBe(304)

  const ranged = await fetch(`${base}/assets/app.js`, {
    headers: { range: "bytes=0-6", "if-range": 'W/"custom"' },
  })
  expect(ranged.status).toBe(200)
  expect(await ranged.text()).toBe("console.log('hi')")
})

test("byte ranges answer 206, 416, or the whole file", async () => {
  const base = await startWithStatic()
  const get = (range: string, extra: Record<string, string> = {}) =>
    fetch(`${base}/assets/app.js`, { headers: { range, ...extra } }) // body: console.log('hi')

  const head = await get("bytes=0-6")
  expect(head.status).toBe(206)
  expect(head.headers.get("content-range")).toBe("bytes 0-6/17")
  expect(head.headers.get("content-length")).toBe("7")
  expect(await head.text()).toBe("console")

  const open = await get("bytes=12-")
  expect(open.status).toBe(206)
  expect(await open.text()).toBe("'hi')")

  const suffix = await get("bytes=-4")
  expect(suffix.headers.get("content-range")).toBe("bytes 13-16/17")
  expect(await suffix.text()).toBe("hi')")

  const clamped = await get("bytes=12-999")
  expect(clamped.headers.get("content-range")).toBe("bytes 12-16/17")
  await clamped.arrayBuffer()

  const unsatisfiable = await get("bytes=17-")
  expect(unsatisfiable.status).toBe(416)
  expect(unsatisfiable.headers.get("content-range")).toBe("bytes */17")
  await unsatisfiable.arrayBuffer()

  // Multi-range, malformed, and inverted specs are ignored: the whole file, 200.
  for (const range of ["bytes=0-1,4-5", "items=0-1", "bytes=5-2"]) {
    const whole = await get(range)
    expect(whole.status).toBe(200)
    expect(await whole.text()).toBe("console.log('hi')")
  }

  // If-Range: the current validator keeps the range, a stale one gets the whole file.
  const etag = (await fetch(`${base}/assets/app.js`, { method: "HEAD" })).headers.get("etag") ?? ""
  expect((await get("bytes=0-6", { "if-range": etag })).status).toBe(206)
  const stale = await get("bytes=0-6", { "if-range": '"stale"' })
  expect(stale.status).toBe(200)
  expect(await stale.text()).toBe("console.log('hi')")

  // HEAD ignores Range and reports the whole representation.
  const headReq = await fetch(`${base}/assets/app.js`, {
    method: "HEAD",
    headers: { range: "bytes=0-6" },
  })
  expect(headReq.status).toBe(200)
  expect(headReq.headers.get("content-length")).toBe("17")
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
  // `%2e%2e%2f` = `../` - survives URL normalization, decoded only after the prefix is stripped.
  const res = await fetch(`${base}/assets/%2e%2e%2fsecret.txt`)
  expect(res.status).toBe(403)
})

test("a `..` PATH SEGMENT is rejected, but a filename containing `..` is served", async () => {
  const base = await startWithStatic()
  // Segment forms of traversal that survive client-side URL normalization (an encoded slash keeps
  // the `..` out of the URL parser's dot-segment collapsing) - all rejected before any filesystem
  // access.
  expect((await fetch(`${base}/assets/x%2f..%2fapp.js`)).status).toBe(403)
  expect((await fetch(`${base}/assets/%5c..%5cx`)).status).toBe(403) // backslash separator
  // A legal filename that merely CONTAINS consecutive dots must still serve - the guard is
  // segment-precise, not a substring match.
  const ok = await fetch(`${base}/assets/logo..png`)
  expect(ok.status).toBe(200)
  expect(await ok.text()).toBe("dotdot")
})

test("dotfiles are denied by default with a 404 indistinguishable from a missing file", async () => {
  const base = await startWithStatic()
  const env = await fetch(`${base}/assets/.env`)
  expect(env.status).toBe(404)
  const missing = await fetch(`${base}/assets/nope.env`)
  // Same status AND body as an absent file - probing can't tell "hidden" from "not there".
  expect(await env.text()).toBe(await missing.text())
  expect((await fetch(`${base}/assets/.git/config`)).status).toBe(404)
})

test("a dot-leading segment MID-path is denied too", async () => {
  const base = await startWithStatic()
  expect((await fetch(`${base}/assets/.hidden/app.js`)).status).toBe(404)
})

test("an encoded dot (%2E) is caught after decoding", async () => {
  const base = await startWithStatic()
  expect((await fetch(`${base}/assets/%2Eenv`)).status).toBe(404)
  expect((await fetch(`${base}/assets/%2egit/config`)).status).toBe(404)
})

test("a filename merely CONTAINING a dot still serves (only the leading dot denies)", async () => {
  const base = await startWithStatic()
  expect((await fetch(`${base}/assets/app.js`)).status).toBe(200)
  expect((await fetch(`${base}/assets/logo..png`)).status).toBe(200)
})

test('dotfiles: "allow" opts out', async () => {
  const base = await startWithStatic(undefined, { dotfiles: "allow" })
  const env = await fetch(`${base}/assets/.env`)
  expect(env.status).toBe(200)
  expect(await env.text()).toBe("SECRET=hunter2")
  expect((await fetch(`${base}/assets/.hidden/app.js`)).status).toBe(200)
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
