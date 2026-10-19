import { expect, setSystemTime, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
// copyPublicDir lives in build.ts: it is build-time (Bun.Glob + node:fs) and public-dir.ts is
// reachable from the client bundle graph, where a Bun builtin import fails the browser build.
import { copyPublicDir } from "../src/build.ts"
import { resolvePublicPath, servePublicDir } from "../src/public-dir.ts"

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "nifra-public-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const get = (path: string, method = "GET") => new Request(`http://x${path}`, { method })
const tagOf = (text: string) =>
  `"${createHash("sha256").update(text).digest("base64url").slice(0, 22)}"`

test("a mutable streamed file never advertises a validator for an earlier read", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "stream.bin")
    const body = "a".repeat(2 * 1024 * 1024)
    await writeFile(path, body)
    const serve = servePublicDir({ dir })
    const response = await serve(get("/stream.bin"))
    await writeFile(path, "b".repeat(body.length))
    expect(response?.headers.get("etag")).toBeNull()
    expect(response?.headers.get("last-modified")).toBeNull()
    await response?.arrayBuffer()
    const resumed = await serve(
      new Request("http://x/stream.bin", {
        headers: { range: "bytes=1-4", "if-range": tagOf(body) },
      }),
    )
    expect(resumed?.status).toBe(200)
    expect((await resumed?.arrayBuffer())?.byteLength).toBe(body.length)
    const head = await serve(get("/stream.bin", "HEAD"))
    expect(head?.headers.get("etag")).toBeNull()
    expect(head?.headers.get("last-modified")).toBeNull()
  })
})

test("a settled streamed file is dated for revalidation, never for resuming a range", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "video.bin")
    const body = "v".repeat(256 * 1024 + 1)
    await writeFile(path, body)
    const serve = servePublicDir({ dir })
    // Just written: a write landing mid-stream could share its HTTP-date second, so it stays undated.
    const fresh = await serve(get("/video.bin"))
    expect(fresh?.headers.get("last-modified")).toBeNull()
    await fresh?.arrayBuffer()
    setSystemTime(new Date(Date.now() + 10_000))
    try {
      const settled = await serve(get("/video.bin"))
      const dated = settled?.headers.get("last-modified") ?? ""
      expect([settled?.headers.get("etag"), dated]).toEqual([
        null,
        new Date((await stat(path)).mtimeMs).toUTCString(),
      ])
      await settled?.arrayBuffer()
      const current = await serve(ranged("/video.bin", { "if-modified-since": dated }))
      expect(current?.status).toBe(304)
      const resumed = await serve(ranged("/video.bin", { range: "bytes=1-3", "if-range": dated }))
      expect([resumed?.status, (await resumed?.arrayBuffer())?.byteLength]).toEqual([
        200,
        body.length,
      ])
    } finally {
      setSystemTime()
    }
  })
})

test("serves a public file and falls through on a miss", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "favicon.ico"), "icon-bytes")
    const serve = servePublicDir({ dir })

    const hit = await serve(get("/favicon.ico"))
    expect(hit?.status).toBe(200)
    expect(await hit?.text()).toBe("icon-bytes")

    // A miss returns undefined rather than a 404, so the caller routes normally - a static probe
    // must never shadow a route.
    expect(await serve(get("/nope.ico"))).toBeUndefined()
  })
})

test("serves nested extensionless files such as ACME challenges", async () => {
  await withDir(async (dir) => {
    const challengeDir = join(dir, ".well-known", "acme-challenge")
    await mkdir(challengeDir, { recursive: true })
    await writeFile(join(challengeDir, "token"), "challenge-body")
    const serve = servePublicDir({ dir })

    const response = await serve(get("/.well-known/acme-challenge/token"))
    expect(response?.status).toBe(200)
    expect(await response?.text()).toBe("challenge-body")
  })
})

test("never follows a publicDir symlink outside the configured root", async () => {
  await withDir(async (dir) => {
    const root = join(dir, "public")
    await mkdir(root)
    await writeFile(join(dir, "secret.txt"), "TOPSECRET")
    await symlink(join(dir, "secret.txt"), join(root, "leak.txt"))

    const serve = servePublicDir({ dir: root })
    expect(await serve(get("/leak.txt"))).toBeUndefined()
    await expect(copyPublicDir(root, join(dir, "out"))).rejects.toThrow(/symlink/)
  })
})

test("a precomputed public-file set rejects page routes before filesystem lookup", async () => {
  await withDir(async (dir) => {
    // A directory named like a page route. If the probe stat'd extension-less paths it could serve
    // this; more importantly, every page render would pay a stat.
    await mkdir(join(dir, "jobs"), { recursive: true })
    await writeFile(join(dir, "jobs", "index.html"), "should not be served")
    const serve = servePublicDir({ dir, files: new Set(["/.well-known/acme-challenge/token"]) })
    expect(await serve(get("/jobs"))).toBeUndefined()
    expect(await serve(get("/jobs/senior-engineer"))).toBeUndefined()
  })
})

test("cache-control differs by subtree: hashed immutable, public/ revalidating", async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, "assets"), { recursive: true })
    await writeFile(join(dir, "assets", "app-a1b2c3.js"), "//")
    await writeFile(join(dir, "logo.svg"), "<svg/>")
    const serve = servePublicDir({ dir })

    // Content-hashed output can be cached forever; the hash changes when the bytes do.
    expect((await serve(get("/assets/app-a1b2c3.js")))?.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    )
    // A user-authored file keeps its name across deploys, so it must revalidate.
    expect((await serve(get("/logo.svg")))?.headers.get("cache-control")).toBe(
      "public, max-age=86400",
    )
  })
})

test("with hashedFiles, only the listed files are immutable, under the prefix or not", async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, "assets"), { recursive: true })
    await writeFile(join(dir, "assets", "app-a1b2c3.js"), "//")
    await writeFile(join(dir, "assets", "logo.png"), "png")
    const serve = servePublicDir({ dir, hashedFiles: new Set(["/assets/app-a1b2c3.js"]) })
    const cacheOf = async (path: string) => (await serve(get(path)))?.headers.get("cache-control")

    expect(await cacheOf("/assets/app-a1b2c3.js")).toBe("public, max-age=31536000, immutable")
    expect(await cacheOf("/assets/logo.png")).toBe("public, max-age=86400")
    // Without the list the prefix still decides, as before.
    const byPrefix = servePublicDir({ dir })
    expect((await byPrefix(get("/assets/logo.png")))?.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    )
  })
})

test("path traversal is rejected, including encoded and NUL forms", async () => {
  await withDir(async (dir) => {
    const root = join(dir, "public")
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "ok.txt"), "inside")
    await writeFile(join(dir, "secret.txt"), "OUTSIDE - must never be served")
    const serve = servePublicDir({ dir: root })

    for (const attack of [
      "/../secret.txt",
      "/..%2fsecret.txt",
      "/%2e%2e%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/a/../../secret.txt",
      "/....//secret.txt",
    ]) {
      const res = await serve(get(attack))
      // Either refused outright or resolved to something inside the root - never the outside file.
      if (res !== undefined) expect(await res.text()).not.toContain("OUTSIDE")
    }

    // Resolution is checked directly too: this is the one part of the feature with a security
    // consequence, so the sink gets its own assertions rather than only end-to-end ones.
    //
    // The property is CONTAINMENT, not rejection. A leading `..` at the root collapses during
    // normalize - `/../secret.txt` becomes `/secret.txt`, resolved inside the root - which is the
    // same clamping every static server does and is safe: it names a file that isn't there.
    // Asserting `undefined` here would be asserting an implementation detail, and would fail for a
    // correct implementation.
    for (const attack of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/a/../../secret.txt",
      "/..%2f..%2fsecret.txt",
    ]) {
      const resolved = resolvePublicPath(root, attack)
      if (resolved !== undefined) {
        expect(resolved.startsWith(root + sep)).toBe(true)
        expect(resolved).not.toBe(join(dir, "secret.txt"))
      }
    }
    // Refused outright: these are not paths to clamp, they are inputs we decline to guess at.
    expect(resolvePublicPath(root, "/a\0.txt")).toBeUndefined()
    expect(resolvePublicPath(root, "/%ZZ")).toBeUndefined() // malformed encoding
    expect(resolvePublicPath(root, "/ok.txt")).toBe(join(root, "ok.txt"))

    // And the legitimate file still serves.
    expect(await (await serve(get("/ok.txt")))?.text()).toBe("inside")
  })
})

test("HEAD matches GET's headers without a body; other methods fall through", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "a.txt"), "body")
    const serve = servePublicDir({ dir })
    const head = await serve(get("/a.txt", "HEAD"))
    expect(head?.status).toBe(200)
    expect(await head?.text()).toBe("")
    expect(head?.headers.get("cache-control")).toBe("public, max-age=86400")
    // A POST to a static path is not a static read; leave it to routing.
    expect(await serve(get("/a.txt", "POST"))).toBeUndefined()
  })
})

test("copyPublicDir mirrors the tree and reports URL paths", async () => {
  await withDir(async (dir) => {
    const from = join(dir, "public")
    const to = join(dir, "out")
    await mkdir(join(from, "fonts"), { recursive: true })
    await writeFile(join(from, "robots.txt"), "User-agent: *")
    await writeFile(join(from, "fonts", "inter.woff2"), "font")
    await mkdir(join(from, ".well-known", "acme-challenge"), { recursive: true })
    await writeFile(join(from, ".well-known", "acme-challenge", "token"), "acme")
    // Hidden files are never shipped, as development never serves them; a link inside one is not
    // even looked at.
    await writeFile(join(from, ".env"), "SECRET=1")
    await mkdir(join(from, ".git"), { recursive: true })
    await writeFile(join(from, ".git", "config"), "[core]")
    await symlink(join(dir, "elsewhere"), join(from, ".git", "link"))
    await writeFile(join(from, "fonts", ".DS_Store"), "x")
    await mkdir(join(from, ".well-known", ".private"), { recursive: true })
    await writeFile(join(from, ".well-known", ".private", "key"), "k")

    const copied = await copyPublicDir(from, to)
    // `.well-known` is the one dot-directory shipped: it is exactly the kind of file this exists to serve.
    expect(copied).toEqual([
      "/.well-known/acme-challenge/token",
      "/fonts/inter.woff2",
      "/robots.txt",
    ])
    expect(await Bun.file(join(to, "fonts", "inter.woff2")).text()).toBe("font")
    for (const hidden of [
      ".env",
      ".git",
      join("fonts", ".DS_Store"),
      join(".well-known", ".private"),
    ]) {
      expect(await Bun.file(join(to, hidden)).exists()).toBe(false)
    }

    // The copied output serves through the same handler.
    const serve = servePublicDir({ dir: to })
    expect(await (await serve(get("/robots.txt")))?.text()).toBe("User-agent: *")
    expect(await (await serve(get("/.well-known/acme-challenge/token")))?.text()).toBe("acme")
  })
})

// The reported paths are an ALLOWLIST: the generated server entry and cloudflare `_routes.json` match a
// request's `URL.pathname` against them by exact string. So the encoding has to be the one a browser
// actually sends, not merely "an" encoding. `encodeURIComponent` escapes the sub-delimiters (`, @ + = &
// ; $`) that browsers send raw, which would make every such file a production-only 404.
test("copyPublicDir encodes URL paths the way a request URL does", async () => {
  await withDir(async (dir) => {
    const from = join(dir, "public")
    const to = join(dir, "out")
    await mkdir(from, { recursive: true })
    const names = ["report,2026.csv", "a@b.txt", "a+b.txt", "spaced name.txt", "café.txt"]
    for (const name of names) await writeFile(join(from, name), name)

    const copied = await copyPublicDir(from, to)
    for (const name of names) {
      const requested = new URL(`http://x/${name}`).pathname
      expect(copied, `${name} must be recorded as the browser requests it`).toContain(requested)
    }
    // And the recorded path still resolves back to the file on disk.
    const serve = servePublicDir({ dir: to, files: new Set(copied) })
    for (const name of names) {
      const requested = new URL(`http://x/${name}`).pathname
      expect(await (await serve(get(requested)))?.text()).toBe(name)
    }
  })
})

test("a missing public/ directory is not an error", async () => {
  await withDir(async (dir) => {
    const serve = servePublicDir({ dir: join(dir, "does-not-exist") })
    expect(await serve(get("/whatever.txt"))).toBeUndefined()
  })
})

// A name inside the root that cannot be opened as a file, such as a socket, falls through like a
// missing one instead of failing the request.
test.skipIf(process.platform === "win32")(
  "a public name that cannot be opened falls through",
  async () => {
    await withDir(async (dir) => {
      const server = createServer()
      await new Promise<void>((resolve) => server.listen(join(dir, "live.sock"), resolve))
      try {
        expect(await servePublicDir({ dir })(get("/live.sock"))).toBeUndefined()
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  },
)

test("a directory is not served as a public file", async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, "assets"))
    const serve = servePublicDir({ dir })
    expect(await serve(get("/assets"))).toBeUndefined()
  })
})

test("a symlinked DIRECTORY inside publicDir cannot leak its contents either", async () => {
  // The per-entry symlink check catches a symlinked FILE. A symlinked directory is the same escape
  // wearing a different hat: every regular file inside it lstats as a plain file, so only resolving
  // the real path shows it landing outside the root. Copying it would publish whatever it points at.
  await withDir(async (dir) => {
    const root = join(dir, "public")
    await mkdir(root)
    await mkdir(join(dir, "outside"))
    await writeFile(join(dir, "outside", "secret.txt"), "TOPSECRET")
    await symlink(join(dir, "outside"), join(root, "linked"))

    await expect(copyPublicDir(root, join(dir, "out"))).rejects.toThrow(/symlink/)
    // And nothing under it is servable.
    const serve = servePublicDir({ dir: root })
    expect(await serve(get("/linked/secret.txt"))).toBeUndefined()
  })
})

// A media file under public/ is the whole reason byte ranges matter here: without Accept-Ranges and
// a 206, a browser cannot seek a <video> and a download manager cannot resume.
const ranged = (path: string, headers: Record<string, string>, method = "GET") =>
  new Request(`http://x${path}`, { method, headers })

test("serves a byte range as 206 with content-range", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "clip.bin"), "0123456789")
    const serve = servePublicDir({ dir })

    const full = await serve(get("/clip.bin"))
    expect(full?.headers.get("accept-ranges")).toBe("bytes")

    const partial = await serve(ranged("/clip.bin", { range: "bytes=2-5" }))
    expect(partial?.status).toBe(206)
    expect(partial?.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(partial?.headers.get("content-length")).toBe("4")
    expect(await partial?.text()).toBe("2345")
  })
})

test("a suffix range and an open-ended range both resolve against the real size", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "clip.bin"), "0123456789")
    const serve = servePublicDir({ dir })

    const suffix = await serve(ranged("/clip.bin", { range: "bytes=-3" }))
    expect(suffix?.headers.get("content-range")).toBe("bytes 7-9/10")
    expect(await suffix?.text()).toBe("789")

    const open = await serve(ranged("/clip.bin", { range: "bytes=8-" }))
    expect(open?.headers.get("content-range")).toBe("bytes 8-9/10")
    expect(await open?.text()).toBe("89")
  })
})

test("an unsatisfiable range is 416 and a malformed one is ignored", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "clip.bin"), "0123456789")
    const serve = servePublicDir({ dir })

    const unsatisfiable = await serve(ranged("/clip.bin", { range: "bytes=99-200" }))
    expect(unsatisfiable?.status).toBe(416)
    expect(unsatisfiable?.headers.get("content-range")).toBe("bytes */10")

    // A header the parser cannot make sense of must be ignored, not turned into an error.
    const malformed = await serve(ranged("/clip.bin", { range: "pages=1-2" }))
    expect(malformed?.status).toBe(200)
    expect(await malformed?.text()).toBe("0123456789")
  })
})

test("multiple ranges fall back to the full body rather than buffering multipart", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "clip.bin"), "0123456789")
    const serve = servePublicDir({ dir })

    const multi = await serve(ranged("/clip.bin", { range: "bytes=0-1,8-9" }))
    expect(multi?.status).toBe(200)
    expect(await multi?.text()).toBe("0123456789")
  })
})

test("small bodies are read whole and large ones streamed, with the same bytes either way", async () => {
  await withDir(async (dir) => {
    // The handler streams a body past 256 KiB instead of reading it whole, or past 1 MiB on Bun.
    const sizes = [0, 1, 256 * 1024, 256 * 1024 + 1, 1024 * 1024, 1024 * 1024 + 7]
    const files = sizes.map((size) => Uint8Array.from({ length: size }, (_, i) => (i * 31) % 251))
    await Promise.all(files.map((bytes, i) => writeFile(join(dir, `f${i}.bin`), bytes)))
    const serve = servePublicDir({ dir })

    for (const [i, bytes] of files.entries()) {
      const whole = await serve(new Request(`http://local/f${i}.bin`))
      expect(whole?.headers.get("content-length")).toBe(String(bytes.length))
      expect(new Uint8Array(await whole!.arrayBuffer())).toEqual(bytes)
      if (bytes.length < 2) continue

      const end = bytes.length - 2
      const part = await serve(ranged(`/f${i}.bin`, { range: `bytes=1-${end}` }))
      expect(part?.status).toBe(206)
      expect(part?.headers.get("content-length")).toBe(String(end))
      expect(new Uint8Array(await part!.arrayBuffer())).toEqual(bytes.subarray(1, end + 1))
    }
  })
})

/** A GET as Bun.serve answers it on the socket, so chunked framing is visible. */
const onTheWire = (port: number, path: string, range?: string) =>
  new Promise<{ head: string; body: Buffer }>((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = connect(port, "127.0.0.1", () => {
      const rangeLine = range === undefined ? "" : `range: ${range}\r\n`
      socket.write(`GET ${path} HTTP/1.1\r\nhost: x\r\nconnection: close\r\n${rangeLine}\r\n`)
    })
    socket.on("data", (chunk: Buffer) => chunks.push(chunk))
    socket.on("error", reject)
    socket.on("close", () => {
      const raw = Buffer.concat(chunks)
      const split = raw.indexOf("\r\n\r\n")
      resolve({
        head: raw.subarray(0, split).toString("latin1").toLowerCase(),
        body: raw.subarray(split + 4),
      })
    })
  })

test("over Bun.serve, a body up to 1 MiB declares its length whole and ranged", async () => {
  await withDir(async (dir) => {
    const sizes = [256 * 1024 + 1, 1024 * 1024, 1024 * 1024 + 1]
    for (const [i, size] of sizes.entries()) {
      await writeFile(join(dir, `w${i}.bin`), new Uint8Array(size).fill(i + 1))
    }
    const serve = servePublicDir({ dir })
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => (await serve(request)) ?? new Response(null, { status: 404 }),
    })
    try {
      for (const [i, size] of sizes.entries()) {
        const whole = await onTheWire(server.port!, `/w${i}.bin`)
        const part = await onTheWire(server.port!, `/w${i}.bin`, `bytes=1-${size - 2}`)
        expect(whole.head).toStartWith("http/1.1 200")
        expect(part.head).toStartWith("http/1.1 206")
        if (size > 1024 * 1024) {
          // Bun.serve drops a stream body's declared length. Once it keeps it, the Bun cap can go.
          expect(whole.head).toContain("\r\ntransfer-encoding: chunked")
          expect(whole.head).not.toContain("\r\ncontent-length:")
          continue
        }
        expect(whole.head).toContain(`\r\ncontent-length: ${size}`)
        expect(whole.head).not.toContain("transfer-encoding")
        expect(whole.body.byteLength).toBe(size)
        expect(part.head).toContain(`\r\ncontent-length: ${size - 2}`)
        expect(part.head).toContain(`\r\ncontent-range: bytes 1-${size - 2}/${size}`)
        expect(part.body.byteLength).toBe(size - 2)
      }
    } finally {
      await server.stop(true)
    }
  })
})

test("HEAD reports the same headers GET does, and the whole representation under Range", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "clip.txt"), "0123456789")
    const serve = servePublicDir({ dir })

    const getResponse = await serve(get("/clip.txt"))
    const headResponse = await serve(get("/clip.txt", "HEAD"))
    // The old handler built HEAD from a null body, which dropped the inferred content-type.
    expect(headResponse?.headers.get("content-type")).toBe(getResponse?.headers.get("content-type"))
    expect(headResponse?.headers.get("accept-ranges")).toBe("bytes")
    expect(await headResponse?.text()).toBe("")

    // Range is defined for GET only (RFC 9110 section 14.2), as the Node static bridge applies it.
    for (const range of ["bytes=0-3", "bytes=99-"]) {
      const headRange = await serve(ranged("/clip.txt", { range }, "HEAD"))
      expect(headRange?.status).toBe(200)
      expect(headRange?.headers.get("content-range")).toBeNull()
      expect(headRange?.headers.get("content-length")).toBe("10")
      expect(await headRange?.text()).toBe("")
    }
  })
})

test("If-Modified-Since produces a 304 and If-Range guards partial answers", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "clip.bin"), "0123456789")
    const serve = servePublicDir({ dir })
    const first = await serve(get("/clip.bin"))
    const lastModified = first?.headers.get("last-modified") ?? ""
    const etag = first?.headers.get("etag") ?? ""
    expect(lastModified).not.toBe("")
    expect(etag).toBe(tagOf("0123456789"))

    const fresh = await serve(ranged("/clip.bin", { "if-modified-since": lastModified }))
    expect(fresh?.status).toBe(304)
    expect(fresh?.headers.get("etag")).toBe(etag)
    expect(await fresh?.text()).toBe("")

    // The file's tag keeps the 206.
    const matched = await serve(ranged("/clip.bin", { range: "bytes=0-1", "if-range": etag }))
    expect(matched?.status).toBe(206)

    // A stale validator means the client's byte offsets may no longer describe this file, and with a
    // strong tag to resume by, even the file's own date does not stand in for it: send all of it.
    for (const validator of ["Tue, 01 Jan 2019 00:00:00 GMT", lastModified, '"stale"']) {
      const stale = await serve(ranged("/clip.bin", { range: "bytes=0-1", "if-range": validator }))
      expect(stale?.status).toBe(200)
      expect(await stale?.text()).toBe("0123456789")
    }
  })
})

test("a file a copy dated is tagged, not dated, and a same-size replacement changes its tag", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "kept.txt")
    await writeFile(path, "first")
    await utimes(path, 1, 1)
    const serve = servePublicDir({ dir })
    const first = await serve(get("/kept.txt"))
    const etag = first?.headers.get("etag") ?? ""
    expect([etag, first?.headers.get("last-modified")]).toEqual([tagOf("first"), null])
    await writeFile(path, "other")
    await utimes(path, 1, 1)
    for (const headers of [
      { "if-none-match": etag },
      { "if-modified-since": new Date(1000).toUTCString() },
      { range: "bytes=0-1", "if-range": etag },
      { range: "bytes=0-1", "if-range": new Date(1000).toUTCString() },
    ]) {
      const response = await serve(ranged("/kept.txt", headers))
      expect([headers, response?.status, await response?.text()]).toEqual([headers, 200, "other"])
    }
  })
})

test("only whole snapshots have validators, including after a same-size replacement", async () => {
  // Ten seconds on, the files written here look settled, so their tags are remembered.
  setSystemTime(new Date(Date.now() + 10_000))
  try {
    await withDir(async (dir) => {
      const serve = servePublicDir({ dir })
      for (const [name, body] of [
        ["small.txt", "first"],
        // Past the rehash cut, a remembered tag is reused once a restat shows the same version.
        ["mid.bin", "m".repeat(64 * 1024)],
        ["large.bin", "f".repeat(1024 * 1024 + 1)],
      ] as const) {
        const path = join(dir, name)
        await writeFile(path, body)
        await utimes(path, 1, 1)
        const first = await serve(get(`/${name}`))
        const etag = first?.headers.get("etag") ?? ""
        const tagged = body.length <= 256 * 1024
        expect([etag, (await first?.text())?.length]).toEqual([
          tagged ? tagOf(body) : "",
          body.length,
        ])
        const remembered = await serve(ranged(`/${name}`, { "if-none-match": etag }))
        expect(remembered?.status).toBe(tagged ? 304 : 200)
        await remembered?.arrayBuffer()
        const again = await serve(ranged(`/${name}`, { range: "bytes=1-3", "if-range": etag }))
        expect([again?.status, await again?.text()]).toEqual(
          tagged ? [206, body.slice(1, 4)] : [200, body],
        )
        const partial = await serve(ranged(`/${name}`, { range: "bytes=1-3" }))
        expect([partial?.status, await partial?.text()]).toEqual([206, body.slice(1, 4)])
        for (const replace of ["in place", "renamed over"]) {
          const next = (replace === "in place" ? "o" : "r").repeat(body.length)
          const target = replace === "in place" ? path : join(dir, `.${name}`)
          await writeFile(target, next)
          await utimes(target, 1, 1)
          if (target !== path) await rename(target, path)
          const replaced = await serve(ranged(`/${name}`, { "if-none-match": etag }))
          expect([replace, replaced?.status, replaced?.headers.get("etag")]).toEqual([
            replace,
            200,
            tagged ? tagOf(next) : null,
          ])
          await replaced?.arrayBuffer()
        }
      }
    })
  } finally {
    setSystemTime()
  }
})

/** Counts reads through every `FileHandle` until `restore()`. */
async function countFileReads(): Promise<{ readonly count: () => number; restore(): void }> {
  const probe = await open(import.meta.path)
  const proto = Object.getPrototypeOf(probe)
  await probe.close()
  const read = proto.read
  let reads = 0
  proto.read = function (this: unknown, ...args: unknown[]) {
    reads++
    return read.apply(this, args)
  }
  return {
    count: () => reads,
    restore: () => {
      proto.read = read
    },
  }
}

test("a HEAD or a 304 of a remembered version reads none of the file", async () => {
  // Ten seconds on, the file written here looks settled, so its tag and date are both kept.
  setSystemTime(new Date(Date.now() + 10_000))
  const reads = await countFileReads()
  try {
    await withDir(async (dir) => {
      const serve = servePublicDir({ dir })
      const body = "k".repeat(8 * 1024)
      const path = join(dir, "kept.txt")
      await writeFile(path, body)
      const first = await serve(get("/kept.txt"))
      const etag = first?.headers.get("etag") ?? ""
      const dated = first?.headers.get("last-modified") ?? ""
      expect([etag, await first?.text()]).toEqual([tagOf(body), body])
      const before = reads.count()
      const head = await serve(get("/kept.txt", "HEAD"))
      const matched = await serve(ranged("/kept.txt", { "if-none-match": etag }))
      const unmodified = await serve(ranged("/kept.txt", { "if-modified-since": dated }))
      expect([
        head?.status,
        head?.headers.get("etag"),
        head?.headers.get("content-length"),
        matched?.status,
        matched?.headers.get("etag"),
        unmodified?.status,
        reads.count() - before,
      ]).toEqual([200, etag, String(body.length), 304, etag, 304, 0])
      // Any other request still sends, and so reads, the snapshot it tags.
      const stale = await serve(ranged("/kept.txt", { "if-none-match": '"other"' }))
      expect([stale?.status, await stale?.text()]).toEqual([200, body])
      expect(reads.count()).toBeGreaterThan(before)
    })
  } finally {
    reads.restore()
    setSystemTime()
  }
})

test("hides dot-segments other than .well-known", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, ".env"), "SECRET=1")
    await mkdir(join(dir, ".git"), { recursive: true })
    await writeFile(join(dir, ".git", "config"), "[core]")
    await mkdir(join(dir, ".well-known"), { recursive: true })
    await writeFile(join(dir, ".well-known", "security.txt"), "Contact: x")
    const serve = servePublicDir({ dir })

    expect(await serve(get("/.env"))).toBeUndefined()
    expect(await serve(get("/%2eenv"))).toBeUndefined()
    expect(await serve(get("/.git/config"))).toBeUndefined()
    expect(await (await serve(get("/.well-known/security.txt")))?.text()).toBe("Contact: x")
  })
})

test("a visible name linking to a hidden file inside the root is hidden too", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, ".env"), "SECRET=1")
    await symlink(join(dir, ".env"), join(dir, "visible.txt"))
    const serve = servePublicDir({ dir })
    expect(await serve(get("/visible.txt"))).toBeUndefined()
  })
})

test("declares the media type from the extension and forbids sniffing", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "app.js"), "1")
    await writeFile(join(dir, "font.WOFF2"), "1")
    await writeFile(join(dir, "blob"), "1")
    const serve = servePublicDir({ dir })

    const js = await serve(get("/app.js"))
    expect(js?.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(js?.headers.get("x-content-type-options")).toBe("nosniff")
    expect((await serve(get("/font.WOFF2")))?.headers.get("content-type")).toBe("font/woff2")
    expect((await serve(get("/blob")))?.headers.get("content-type")).toBe(
      "application/octet-stream",
    )
  })
})

test("does not depend on the Bun global, so the Node and Deno adapters can serve public/", async () => {
  // A `Bun.file` here once made every public/ hit throw `Bun is not defined` off Bun.
  const source = await Bun.file(join(import.meta.dir, "..", "src", "public-dir.ts")).text()
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n")
  expect(code).not.toMatch(/\bBun\./)
})
