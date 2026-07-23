import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
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

test("serves a public file and falls through on a miss", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "favicon.ico"), "icon-bytes")
    const serve = servePublicDir({ dir })

    const hit = await serve(get("/favicon.ico"))
    expect(hit?.status).toBe(200)
    expect(await hit?.text()).toBe("icon-bytes")

    // A miss returns undefined rather than a 404, so the caller routes normally — a static probe
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

test("path traversal is rejected, including encoded and NUL forms", async () => {
  await withDir(async (dir) => {
    const root = join(dir, "public")
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "ok.txt"), "inside")
    await writeFile(join(dir, "secret.txt"), "OUTSIDE — must never be served")
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
      // Either refused outright or resolved to something inside the root — never the outside file.
      if (res !== undefined) expect(await res.text()).not.toContain("OUTSIDE")
    }

    // Resolution is checked directly too: this is the one part of the feature with a security
    // consequence, so the sink gets its own assertions rather than only end-to-end ones.
    //
    // The property is CONTAINMENT, not rejection. A leading `..` at the root collapses during
    // normalize — `/../secret.txt` becomes `/secret.txt`, resolved inside the root — which is the
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

    const copied = await copyPublicDir(from, to)
    // Dotfiles are included: `.well-known` is exactly the kind of file this exists to serve.
    expect(copied).toEqual([
      "/.well-known/acme-challenge/token",
      "/fonts/inter.woff2",
      "/robots.txt",
    ])
    expect(await Bun.file(join(to, "fonts", "inter.woff2")).text()).toBe("font")

    // The copied output serves through the same handler.
    const serve = servePublicDir({ dir: to })
    expect(await (await serve(get("/robots.txt")))?.text()).toBe("User-agent: *")
    expect(await (await serve(get("/.well-known/acme-challenge/token")))?.text()).toBe("acme")
  })
})

// The reported paths are an ALLOWLIST: the generated server entry and cf-pages `_routes.json` match a
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
