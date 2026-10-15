import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { type FileHandle, open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DRAFT_COOKIE, enableDraft } from "../src/draft.ts"
import {
  createWebApp,
  type Manifest,
  type PrerenderedPages,
  prerenderedPageReader,
  type RenderAdapter,
} from "../src/index.ts"
import {
  prerenderedDocumentHeaders,
  servablePrerenderedPages,
} from "../src/internal/prerendered-pages.ts"
import { createNonceResolver } from "../src/nonce.ts"
import { DATA_HEADER } from "../src/router.ts"

const stub: RenderAdapter = {
  renderToStream: () =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("<p>rendered</p>"))
        c.close()
      },
    }),
  hydrationHead: () => "",
}

const manifest: Manifest = {
  routes: ["/", "/about"].map((pattern) => ({
    id: pattern,
    pattern,
    layoutIds: [],
    file: `${pattern}.tsx`,
    load: async () => ({ default: "page", loader: () => ({ ok: true }) }),
  })),
  layouts: {},
  notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
}

// "é" is two bytes in UTF-8, so a HEAD length counted in characters would be short by one.
const FILE_HTML = "<!doctype html><p>from the file é</p>"

const pagesWith = (read: PrerenderedPages["read"] = async () => FILE_HTML): PrerenderedPages => ({
  pages: { "/": { "content-language": "en" } },
  read,
})

const statusText = async (res: Response) => `${res.status} ${await res.text()}`

describe("prerenderedDocumentHeaders", () => {
  const headersOf = (init: Record<string, string>, status = 200) =>
    prerenderedDocumentHeaders(status, new Headers(init))

  test("replays the route's own document headers and nothing else", () => {
    expect(
      headersOf({
        "content-type": "text/html; charset=utf-8",
        "content-language": "de",
        "content-security-policy": "script-src 'sha256-x'",
        "content-security-policy-report-only": "default-src 'self'",
        "x-loader-header": "1",
        "x-nifra-isr-revalidate": "60",
      }),
    ).toEqual({
      "content-language": "de",
      "content-security-policy": "script-src 'sha256-x'",
      "content-security-policy-report-only": "default-src 'self'",
    })
    expect(headersOf({ vary: `Accept-Encoding, ${DATA_HEADER}` })).toEqual({})
  })

  test("a render specific to its request is not servable as a file", () => {
    expect(headersOf({ "set-cookie": "sid=1" })).toBeUndefined()
    expect(headersOf({ "cache-control": "private, no-store" })).toBeUndefined()
    expect(headersOf({ "cache-control": "no-store" })).toBeUndefined()
    expect(headersOf({ "cache-control": "Private" })).toBeUndefined()
    expect(headersOf({ vary: "accept-language" })).toBeUndefined()
    expect(headersOf({ vary: "*" })).toBeUndefined()
    expect(headersOf({}, 203)).toBeUndefined()
  })
})

describe("servablePrerenderedPages", () => {
  const ok = { "content-language": "en" }

  test("keys each page by the pathname of the request that rendered it", () => {
    expect(
      servablePrerenderedPages([
        { path: "/", file: "index.html", serveHeaders: ok },
        { path: "//x", file: "x/index.html", serveHeaders: ok },
        { path: "/blog/caf%C3%A9", file: "blog/café/index.html", serveHeaders: ok },
        { path: "/private", file: "private/index.html" },
      ]),
    ).toEqual({
      "/": { file: "index.html", headers: ok },
      // Not "/": parsed against a base, "//x" would name a host and key the root page.
      "//x": { file: "x/index.html", headers: ok },
      "/blog/caf%C3%A9": { file: "blog/café/index.html", headers: ok },
    })
  })

  test("two paths written to one file are both left to render on demand", () => {
    expect(
      servablePrerenderedPages([
        { path: "/x", file: "x/index.html", serveHeaders: ok },
        { path: "//x", file: "x/index.html", serveHeaders: ok },
        { path: "/About", file: "About/index.html", serveHeaders: ok },
        { path: "/about", file: "about/index.html", serveHeaders: ok },
        { path: "/kept", file: "kept/index.html", serveHeaders: ok },
      ]),
    ).toEqual({ "/kept": { file: "kept/index.html", headers: ok } })
  })
})

describe("createWebApp prerenderedPages", () => {
  test("an app with a nonce renders every page on demand", async () => {
    const app = createWebApp({
      adapter: stub,
      manifest,
      clientEntry: "/c.js",
      nonce: createNonceResolver(),
      prerenderedPages: pagesWith(),
    })
    expect(await (await app.fetch(new Request("http://x/"))).text()).toContain("<p>rendered</p>")
  })

  test("a plain document request is answered from the file with the replayed headers", async () => {
    const app = createWebApp({
      adapter: stub,
      manifest,
      clientEntry: "/c.js",
      prerenderedPages: pagesWith(),
    })
    const res = await app.fetch(new Request("http://x/"))
    expect(await statusText(res)).toBe(`200 ${FILE_HTML}`)
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(res.headers.get("content-language")).toBe("en")
  })

  test("HEAD reports the file's byte length without a body", async () => {
    const app = createWebApp({
      adapter: stub,
      manifest,
      clientEntry: "/c.js",
      prerenderedPages: pagesWith(),
    })
    const res = await app.fetch(new Request("http://x/", { method: "HEAD" }))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(FILE_HTML).byteLength),
    )
    expect(await res.text()).toBe("")
  })

  test("anything a file cannot answer as a render would renders on demand", async () => {
    const reads: string[] = []
    const app = createWebApp({
      adapter: stub,
      manifest,
      clientEntry: "/c.js",
      prerenderedPages: pagesWith(async (path) => {
        reads.push(path)
        return FILE_HTML
      }),
    })
    const rendered = async (req: Request) => {
      const text = await (await app.fetch(req)).text()
      expect(text).not.toContain("from the file")
      return text
    }
    expect(await rendered(new Request("http://x/?tab=1"))).toContain("<p>rendered</p>")
    expect(await rendered(new Request("http://x/about"))).toContain("<p>rendered</p>")
    expect(await rendered(new Request("http://x/", { headers: { [DATA_HEADER]: "1" } }))).toContain(
      '"ok":true',
    )
    await rendered(new Request("http://x/", { headers: { "x-nifra-component": "1" } }))
    expect(reads).toEqual([])
  })

  test("a page the reader cannot return renders on demand", async () => {
    const app = createWebApp({
      adapter: stub,
      manifest,
      clientEntry: "/c.js",
      prerenderedPages: pagesWith(async () => undefined),
    })
    expect(await (await app.fetch(new Request("http://x/"))).text()).toContain("<p>rendered</p>")
  })

  test("a draft-mode visitor gets the render, everyone else the file", async () => {
    const secret = "draft-secret-for-tests-0123456789"
    let cookie = ""
    await enableDraft(
      { set: { cookie: (_name, value) => (cookie = value), deleteCookie() {} } },
      secret,
    )
    const app = createWebApp({
      adapter: stub,
      manifest,
      clientEntry: "/c.js",
      draftSecret: secret,
      prerenderedPages: pagesWith(),
    })
    const draft = await app.fetch(
      new Request("http://x/", { headers: { cookie: `${DRAFT_COOKIE}=${cookie}` } }),
    )
    expect(await draft.text()).toContain("<p>rendered</p>")
    expect(await (await app.fetch(new Request("http://x/"))).text()).toBe(FILE_HTML)
  })

  test("`use` middleware runs first: a gate still refuses, a response hook still applies", async () => {
    let reads = 0
    const app = createWebApp({
      adapter: stub,
      manifest,
      clientEntry: "/c.js",
      prerenderedPages: pagesWith(async () => {
        reads += 1
        return FILE_HTML
      }),
      use: (app) => {
        app.onRequest((request) =>
          request.headers.get("authorization") === "ok"
            ? undefined
            : new Response("denied", { status: 401 }),
        )
        app.onResponse((response) => {
          const headers = new Headers(response.headers)
          headers.set("x-frame-options", "DENY")
          return new Response(response.body, { status: response.status, headers })
        })
      },
    })
    expect(await statusText(await app.fetch(new Request("http://x/")))).toBe("401 denied")
    expect(reads).toBe(0)
    const res = await app.fetch(new Request("http://x/", { headers: { authorization: "ok" } }))
    expect(await statusText(res)).toBe(`200 ${FILE_HTML}`)
    expect(res.headers.get("x-frame-options")).toBe("DENY")
  })
})

describe("prerenderedPageReader", () => {
  let dir: string
  let outside: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nifra-prerendered-"))
    outside = mkdtempSync(join(tmpdir(), "nifra-outside-"))
    mkdirSync(join(dir, "about"))
    writeFileSync(join(dir, "index.html"), "home")
    writeFileSync(join(dir, "about/index.html"), "about")
    writeFileSync(join(outside, "secret.html"), "outside")
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  test("reads a listed page and keeps it once read", async () => {
    const read = prerenderedPageReader({ dir, files: { "/": "index.html" } })
    expect(await read("/")).toBe("home")
    writeFileSync(join(dir, "index.html"), "changed")
    expect(await read("/")).toBe("home")
  })

  test("a page past the memory budget is read on every request", async () => {
    const read = prerenderedPageReader({ dir, files: { "/": "index.html" }, cacheBytes: 0 })
    expect(await read("/")).toBe("home")
    writeFileSync(join(dir, "index.html"), "changed")
    expect(await read("/")).toBe("changed")
  })

  test("only the build's own files, inside the directory, are reachable", async () => {
    symlinkSync(join(outside, "secret.html"), join(dir, "linked.html"))
    writeFileSync(join(dir, ".env"), "TOKEN=1")
    const read = prerenderedPageReader({
      dir,
      files: {
        "/about": "about/index.html",
        "/missing": "missing/index.html",
        "/linked": "linked.html",
        "/escape": "../secret.html",
        "/hidden": ".env",
        "/dir": "about",
      },
    })
    expect(await read("/about")).toBe("about")
    expect(await read("/unlisted")).toBeUndefined()
    expect(await read("/missing")).toBeUndefined()
    expect(await read("/linked")).toBeUndefined()
    expect(await read("/escape")).toBeUndefined()
    expect(await read("/hidden")).toBeUndefined()
    expect(await read("/dir")).toBeUndefined()
  })

  test("a directory that is not there reads no page", async () => {
    const read = prerenderedPageReader({ dir: join(dir, "gone"), files: { "/": "index.html" } })
    expect(await read("/")).toBeUndefined()
  })

  test("a page is served when its file fails to close", async () => {
    const probe = await open(join(dir, "index.html"))
    const proto: FileHandle = Object.getPrototypeOf(probe)
    await probe.close()
    const close = proto.close
    const spy = spyOn(proto, "close").mockImplementationOnce(async function (this: FileHandle) {
      await close.call(this)
      throw new Error("EIO")
    })
    try {
      const read = prerenderedPageReader({ dir, files: { "/": "index.html" } })
      expect(await read("/")).toBe("home")
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})
