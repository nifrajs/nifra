import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { serveStatic } from "../src/serve-static.ts"
import { server } from "../src/server.ts"
import {
  STATIC_MOUNT_CASES,
  STATIC_MOUNTS_APP,
  staticMountAnswer,
  staticMounts,
} from "./static-mounts.ts"

let running: { readonly port: number; stop(): unknown } | undefined
let base = ""

beforeAll(() => {
  running = server()
    .get("/*", (c) => c.text(STATIC_MOUNTS_APP))
    .post("/*", (c) => c.text(STATIC_MOUNTS_APP))
    .listen(0, { hostname: "127.0.0.1", static: serveStatic(staticMounts()) })
  base = `http://127.0.0.1:${running.port}`
})

afterAll(async () => {
  await running?.stop()
})

describe("serveStatic through listen()", () => {
  for (const [name, path, method, expected] of STATIC_MOUNT_CASES) {
    test(name, async () => {
      expect(await staticMountAnswer(base, path, method, expected)).toEqual(expected)
    })
  }
})

test("a request no mount takes is passed on synchronously", () => {
  const handler = serveStatic(staticMounts())
  expect(handler(new Request("http://x/elsewhere"))).toBeUndefined()
  expect(handler(new Request("http://x/x/shared.txt", { method: "POST" }))).toBeUndefined()
})

test("allow sees the request's host and its path as sent", async () => {
  const seen: [string, string][] = []
  const handler = serveStatic({
    dir: new URL("./fixtures/static-mounts/one/", import.meta.url),
    prefix: "/",
    allow: (host, pathname) => {
      seen.push([host, pathname])
      return false
    },
  })
  expect(handler(new Request("http://app.example:8080/only%2Done.txt?q=1"))).toBeUndefined()
  expect(seen).toEqual([["app.example:8080", "/only%2Done.txt"]])
})

test("a mount over a directory made after it serves once the directory exists", async () => {
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const parent = mkdtempSync(join(tmpdir(), "nifra-serve-static-"))
  try {
    const handler = serveStatic({ dir: join(parent, "later"), prefix: "/" })
    expect((await handler(new Request("http://x/a.txt")))?.status).toBe(404)
    mkdirSync(join(parent, "later"))
    writeFileSync(join(parent, "later", "a.txt"), "made later")
    expect(await (await handler(new Request("http://x/a.txt")))?.text()).toBe("made later")
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test("each body lane answers whole, ranged and HEAD requests with the file's bytes", async () => {
  const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const dir = mkdtempSync(join(tmpdir(), "nifra-serve-static-lanes-"))
  // Hashed whole; read past the content snapshot; streamed past the buffered-body limit.
  const sizes = { small: 100, unsnapshotted: 512 * 1024, streamed: 2 * 1024 * 1024 }
  const bytesOf = (size: number) => Uint8Array.from({ length: size }, (_, i) => i % 251)
  try {
    for (const [name, size] of Object.entries(sizes))
      writeFileSync(join(dir, `${name}.bin`), bytesOf(size))
    writeFileSync(join(dir, ".env"), "SECRET=1")
    symlinkSync(join(dir, ".env"), join(dir, "env.txt"))
    const handler = serveStatic({ dir, prefix: "/" })
    const get = async (path: string, init?: RequestInit) => {
      const response = await handler(new Request(`http://x${path}`, init))
      if (response === undefined) throw new Error(`no mount took ${path}`)
      return response
    }
    for (const [name, size] of Object.entries(sizes)) {
      const whole = await get(`/${name}.bin`)
      expect([name, whole.status]).toEqual([name, 200])
      expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytesOf(size))
      const last = Math.min(size - 1, 1024 * 1024 + 9)
      const part = await get(`/${name}.bin`, { headers: { range: `bytes=10-${last}` } })
      expect([name, part.status, part.headers.get("content-range")]).toEqual([
        name,
        206,
        `bytes 10-${last}/${size}`,
      ])
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytesOf(size).subarray(10, last + 1))
      const head = await get(`/${name}.bin`, { method: "HEAD" })
      expect([name, head.headers.get("content-length"), await head.text()]).toEqual([
        name,
        String(size),
        "",
      ])
    }
    // A visible name linking to a hidden file inside the directory answers as a missing file does.
    expect((await get("/env.txt")).status).toBe(404)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("hashedFiles marks the files it names immutable, in each form it takes", async () => {
  const dir = new URL("./fixtures/static-mounts/two/", import.meta.url)
  const IMMUTABLE = "public, max-age=31536000, immutable"
  const forms = {
    paths: ["/only-two.txt"],
    patterns: [/only-two/],
    // Tested twice below: a global RegExp must not keep `lastIndex` between paths.
    global: [/only-two/g],
    predicate: (path: string) => path === "/only-two.txt",
  }
  for (const [name, hashedFiles] of Object.entries(forms)) {
    const handler = serveStatic({ dir, prefix: "/", hashedFiles, cacheControl: "no-cache" })
    const cacheOf = async (path: string) =>
      (await handler(new Request(`http://x${path}`)))?.headers.get("cache-control")
    expect([name, await cacheOf("/only-two.txt"), await cacheOf("/only-two.txt")]).toEqual([
      name,
      IMMUTABLE,
      IMMUTABLE,
    ])
    expect([name, await cacheOf("/shared.txt")]).toEqual([name, "no-cache"])
  }
  for (const hashedFiles of [new Map([["/only-two.txt", false]]), [1], 7]) {
    expect(() => Reflect.apply(serveStatic, undefined, [{ dir, hashedFiles }])).toThrow(
      "hashedFiles must be paths, an array of RegExps, or a function",
    )
  }
})

test("a matching validator answers 304, and a range past the end 416", async () => {
  const handler = serveStatic({
    dir: new URL("./fixtures/static-mounts/two/", import.meta.url),
    prefix: "/",
  })
  const get = async (init?: RequestInit) => {
    const response = await handler(new Request("http://x/only-two.txt", init))
    if (response === undefined) throw new Error("no mount took /only-two.txt")
    return response
  }
  const etag = (await get()).headers.get("etag")
  expect(etag).not.toBeNull()
  const fresh = await get({ headers: { "if-none-match": etag ?? "" } })
  expect([fresh.status, await fresh.text()]).toEqual([304, ""])
  const past = await get({ headers: { range: "bytes=1000-2000" } })
  expect([past.status, past.headers.get("content-range")]).toEqual([416, "bytes */8"])
})

test("a file that grows after its stat is sent at the stat's length", async () => {
  const { appendFileSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const dir = mkdtempSync(join(tmpdir(), "nifra-serve-static-grow-"))
  const size = 2 * 1024 * 1024
  try {
    writeFileSync(join(dir, "growing.bin"), new Uint8Array(size))
    const response = await serveStatic({ dir, prefix: "/" })(new Request("http://x/growing.bin"))
    appendFileSync(join(dir, "growing.bin"), new Uint8Array(1024))
    expect(response?.headers.get("content-length")).toBe(String(size))
    expect((await response?.arrayBuffer())?.byteLength).toBe(size)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
