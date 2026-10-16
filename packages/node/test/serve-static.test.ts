import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises"
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

test("hashedFiles narrows immutable caching to the listed files", async () => {
  const base = await startWithStatic(undefined, { hashedFiles: ["/assets/app.js"] })
  const hashed = await fetch(`${base}/assets/app.js`)
  expect(hashed.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  await hashed.text()
  const unhashed = await fetch(`${base}/assets/style.css`)
  expect(unhashed.status).toBe(200)
  expect(unhashed.headers.get("cache-control")).toBeNull()
  expect(unhashed.headers.get("etag")).not.toBeNull()
  await unhashed.text()
})

test("hashedFiles matches the served URL path, including a custom prefix", async () => {
  const base = await startWithStatic("/static/", { hashedFiles: new Set(["/static/app.js"]) })
  const listed = await fetch(`${base}/static/app.js?v=1`)
  expect(listed.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  await listed.text()
  const other = await fetch(`${base}/static/style.css`)
  expect(other.headers.get("cache-control")).toBeNull()
  await other.text()
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

test("custom validators still apply to a file with no usable modification time", async () => {
  const path = join(dir, "undated.txt")
  await writeFile(path, "first")
  await utimes(path, 0, 0)
  const lastModified = "Wed, 01 Jan 2020 00:00:00 GMT"
  const base = await startWithStatic(undefined, {
    headers: { ETag: '"custom"', "Last-Modified": lastModified },
  })
  const conditions: Record<string, string>[] = [
    { "if-none-match": 'W/"custom"' },
    { "if-modified-since": lastModified },
  ]
  for (const headers of conditions) {
    const response = await fetch(`${base}/assets/undated.txt`, { headers })
    expect(response.status).toBe(304)
    expect(response.headers.get("etag")).toBe('"custom"')
    expect(response.headers.get("last-modified")).toBe(lastModified)
    expect(await response.text()).toBe("")
  }
  for (const validator of ['"custom"', lastModified]) {
    const response = await fetch(`${base}/assets/undated.txt`, {
      headers: { range: "bytes=1-3", "if-range": validator },
    })
    expect(response.status).toBe(206)
    expect(await response.text()).toBe("irs")
  }
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

  // Parsed by core's parser: an inverted spec selects nothing, and overlapping specs coalesce.
  const inverted = await get("bytes=5-2")
  expect(inverted.status).toBe(416)
  await inverted.arrayBuffer()
  const overlapping = await get("bytes=0-3, 2-6")
  expect(overlapping.headers.get("content-range")).toBe("bytes 0-6/17")
  expect(await overlapping.text()).toBe("console")

  // Disjoint ranges, another unit, and a zero suffix are ignored: the whole file, 200.
  for (const range of ["bytes=0-1,4-5", "items=0-1", "bytes=-0"]) {
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

test("content types come from core's shared table", async () => {
  await writeFile(join(dir, "guide.pdf"), "%PDF")
  await writeFile(join(dir, "clip.mp4"), "mp4")
  await writeFile(join(dir, "feed.xml"), "<rss/>")
  const base = await startWithStatic()
  for (const [file, type] of [
    ["guide.pdf", "application/pdf"],
    ["clip.mp4", "video/mp4"],
    ["feed.xml", "application/xml"],
  ] as const) {
    const res = await fetch(`${base}/assets/${file}`)
    expect(res.headers.get("content-type")).toBe(type)
    await res.text()
  }
})

test("files serves only the listed paths; any other path under the prefix runs the app", async () => {
  const base = await startWithStatic("/", { files: ["/app.js"] })
  const listed = await fetch(`${base}/app.js`)
  expect(listed.status).toBe(200)
  expect(await listed.text()).toBe("console.log('hi')")
  // On disk but unlisted: the app answers, so a mount over a folder holding server code exposes none of it.
  const unlisted = await fetch(`${base}/style.css`)
  expect(unlisted.status).toBe(404)
  expect(await unlisted.text()).not.toBe("body{}")
  const page = await fetch(`${base}/`)
  expect(await page.json()).toEqual({ page: true })
})

test("an array of mounts answers from the first one that takes the path", async () => {
  const other = await mkdtemp(join(tmpdir(), "nifra-static-other-"))
  try {
    await writeFile(join(other, "robots.txt"), "User-agent: *")
    running = await serve(app, {
      hostname: "127.0.0.1",
      port: 0,
      static: [
        { dir, prefix: "/assets" },
        { dir: other, prefix: "/", files: ["/robots.txt"], immutable: false },
      ],
    })
    const base = `http://127.0.0.1:${running.port}`
    const asset = await fetch(`${base}/assets/app.js`)
    expect(await asset.text()).toBe("console.log('hi')")
    const robots = await fetch(`${base}/robots.txt`)
    expect(await robots.text()).toBe("User-agent: *")
    expect(robots.headers.get("cache-control")).toBeNull()
    const page = await fetch(`${base}/`)
    expect(await page.json()).toEqual({ page: true })
  } finally {
    await rm(other, { recursive: true, force: true })
  }
})

test("a path a mount's files leaves out passes to the next mount", async () => {
  const other = await mkdtemp(join(tmpdir(), "nifra-static-other-"))
  try {
    await writeFile(join(other, "robots.txt"), "User-agent: *")
    await writeFile(join(other, "app.js"), "unlisted")
    running = await serve(app, {
      hostname: "127.0.0.1",
      port: 0,
      static: [
        { dir: other, prefix: "/", files: ["/robots.txt"] },
        { dir, prefix: "/" },
      ],
    })
    const base = `http://127.0.0.1:${running.port}`
    expect(await (await fetch(`${base}/robots.txt`)).text()).toBe("User-agent: *")
    expect(await (await fetch(`${base}/app.js`)).text()).toBe("console.log('hi')")
  } finally {
    await rm(other, { recursive: true, force: true })
  }
})

test("cacheControl applies to files not served immutable", async () => {
  const base = await startWithStatic(undefined, {
    hashedFiles: ["/assets/app.js"],
    cacheControl: "public, max-age=86400",
  })
  const hashed = await fetch(`${base}/assets/app.js`)
  expect(hashed.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  await hashed.text()
  const other = await fetch(`${base}/assets/style.css`)
  expect(other.headers.get("cache-control")).toBe("public, max-age=86400")
  await other.text()
})

test("/.well-known is served by default, as servePublicDir serves it", async () => {
  await mkdir(join(dir, ".well-known"), { recursive: true })
  await writeFile(join(dir, ".well-known", "security.txt"), "Contact: x")
  const base = await startWithStatic()
  const res = await fetch(`${base}/assets/.well-known/security.txt`)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe("Contact: x")
})

test("a visible name linking to a dotfile inside the root is denied", async () => {
  await symlink(join(dir, ".env"), join(dir, "config.txt"))
  try {
    const denied = await startWithStatic()
    const res = await fetch(`${denied}/assets/config.txt`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain("hunter2")
    await running?.stop({ drainMs: 0 })
    const allowed = await startWithStatic(undefined, { dotfiles: "allow" })
    expect(await (await fetch(`${allowed}/assets/config.txt`)).text()).toBe("SECRET=hunter2")
  } finally {
    await rm(join(dir, "config.txt"), { force: true })
  }
})

test("a link is typed by the file it resolves to, not by its own name", async () => {
  await symlink(join(dir, "style.css"), join(dir, "alias.js"))
  try {
    const base = await startWithStatic()
    const res = await fetch(`${base}/assets/alias.js`)
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8")
    expect(await res.text()).toBe("body{}")
  } finally {
    await rm(join(dir, "alias.js"), { force: true })
  }
})

test("a link inside the root that points outside it is a 404, like a missing file", async () => {
  const outside = await mkdtemp(join(tmpdir(), "nifra-static-outside-"))
  await writeFile(join(outside, "secret.txt"), "outside")
  await symlink(join(outside, "secret.txt"), join(dir, "escape.txt"))
  try {
    const base = await startWithStatic()
    const res = await fetch(`${base}/assets/escape.txt`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain("outside")
  } finally {
    await rm(join(dir, "escape.txt"), { force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("a file above the buffered size streams with its length, whole and as a range", async () => {
  const size = 256 * 1024 + 1
  await writeFile(join(dir, "stream.bin"), Buffer.alloc(size, 7))
  const base = await startWithStatic()
  const whole = await fetch(`${base}/assets/stream.bin`)
  expect(whole.headers.get("content-length")).toBe(String(size))
  expect((await whole.arrayBuffer()).byteLength).toBe(size)
  const tail = await fetch(`${base}/assets/stream.bin`, { headers: { range: "bytes=1-" } })
  expect(tail.status).toBe(206)
  expect(tail.headers.get("content-length")).toBe(String(size - 1))
  expect((await tail.arrayBuffer()).byteLength).toBe(size - 1)
})

// Cleanup the temp dir last (afterEach handles servers; this removes the fixture).
test("cleanup", async () => {
  await rm(dir, { recursive: true, force: true })
  expect(true).toBe(true)
})
