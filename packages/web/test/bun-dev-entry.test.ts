import { expect, test } from "bun:test"
import {
  devEntryNotFoundMessage,
  parseDevEntry,
  parseDevStyles,
  resolveDevEntry,
} from "../src/bun-dev-entry.ts"

// This adapter reads Bun's dev-server output, which is not a specified format. These tests are the whole
// reason that is acceptable: they pin the exact markup Bun emits today, so a Bun upgrade that changes it
// fails HERE - with a diff of the markup - instead of shipping a dev server that boots fine and serves
// pages whose script tags 404.

// Captured verbatim from `Bun.serve({ development: { hmr: true } })` on Bun 1.3.14, entry importing CSS.
const REAL_BUN_PAGE =
  `<!doctype html><html><head>` +
  `<link rel="stylesheet" href="/_bun/asset/da8637c2ecc78ccf.css">` +
  `<script type="module" crossorigin src="/_bun/client/.css-entry-000000004687f792.js" data-bun-dev-server-script></script>` +
  `<script>((a)=>{document.addEventListener('visibilitychange',globalThis[Symbol.for('bun:loadData')]=()=>document.visibilityState==='hidden'&&navigator.sendBeacon('/_bun/unref',a));})(document.querySelector('[data-bun-dev-server-script]').src.slice(-11,-3))</script>` +
  `</head><body></body></html>`

test("finds the entry + stylesheet in real Bun dev-server output, via the marker", () => {
  const match = parseDevEntry(REAL_BUN_PAGE)
  expect(match).toEqual({
    src: "/_bun/client/.css-entry-000000004687f792.js",
    styles: ["/_bun/asset/da8637c2ecc78ccf.css"],
    via: "marker",
  })
})

test("the inline beacon script is not mistaken for the entry (it has no src)", () => {
  // Bun emits a second, inline <script> right after the entry. A naive "last script wins" or "first
  // script wins" read picks the wrong one; only the marker + src pair is unambiguous.
  expect(parseDevEntry(REAL_BUN_PAGE)?.src).not.toContain("visibilitychange")
})

test("attribute ORDER does not matter (nothing makes Bun's order a contract)", () => {
  const reordered =
    '<script data-bun-dev-server-script src="/_bun/client/x-1.js" type="module"></script>'
  expect(parseDevEntry(reordered)?.src).toBe("/_bun/client/x-1.js")
})

test("single-quoted and unquoted attribute values parse", () => {
  expect(
    parseDevEntry(`<script src='/_bun/client/a.js' data-bun-dev-server-script></script>`)?.src,
  ).toBe("/_bun/client/a.js")
  expect(
    parseDevEntry(`<script src=/_bun/client/b.js data-bun-dev-server-script></script>`)?.src,
  ).toBe("/_bun/client/b.js")
})

test('a valued marker attribute still matches (tolerant of a future `="1"`)', () => {
  const html = '<script src="/_bun/client/c.js" data-bun-dev-server-script="1"></script>'
  expect(parseDevEntry(html)?.via).toBe("marker")
})

test("falls back to a single /_bun/ module script when the marker is gone", () => {
  // A cosmetic Bun change that drops the attribute must degrade, not break: one unambiguous candidate is
  // still a safe answer, and `via` records that the precise signal was not the one that fired.
  const html = '<script type="module" src="/_bun/client/index-abc.js"></script>'
  expect(parseDevEntry(html)).toEqual({
    src: "/_bun/client/index-abc.js",
    styles: [],
    via: "single-bun-script",
  })
})

test("declines rather than guesses when the marker is gone and TWO candidates exist", () => {
  // With no basis for choosing, picking one would be a coin flip that silently serves the wrong chunk.
  const html =
    '<script type="module" src="/_bun/client/a.js"></script>' +
    '<script type="module" src="/_bun/client/b.js"></script>'
  expect(parseDevEntry(html)).toBeUndefined()
})

test("an app's own script is never mistaken for the entry", () => {
  expect(parseDevEntry('<script type="module" src="/static/app.js"></script>')).toBeUndefined()
  expect(parseDevEntry("<html><body>no scripts</body></html>")).toBeUndefined()
})

test("stylesheet links: order preserved, non-stylesheet rels ignored", () => {
  const html =
    '<link rel="preload" href="/nope.css">' +
    '<link rel="stylesheet" href="/a.css">' +
    "<link rel=stylesheet href=/b.css>" +
    `<link href='/c.css' rel='stylesheet'>` +
    '<link rel="modulepreload" href="/x.js">'
  expect(parseDevStyles(html)).toEqual(["/a.css", "/b.css", "/c.css"])
})

test('`rel="stylesheet preload"` (multi-token rel) counts as a stylesheet', () => {
  expect(parseDevStyles('<link rel="preload stylesheet" href="/m.css">')).toEqual(["/m.css"])
})

test("the not-found error names what was searched for AND what was actually there", () => {
  const message = devEntryNotFoundMessage(
    "http://127.0.0.1:3000/__nifra/dev-entry",
    '<script src="/x.js"></script>',
  )
  expect(message).toContain("http://127.0.0.1:3000/__nifra/dev-entry")
  expect(message).toContain("data-bun-dev-server-script")
  // The actual markup is echoed back — without it the reader cannot tell what Bun changed.
  expect(message).toContain('<script src="/x.js">')
})

test("the not-found error says so explicitly when there were no scripts at all", () => {
  expect(devEntryNotFoundMessage("http://x/y", "<html></html>")).toContain(
    "no <script> tags at all",
  )
})

test("resolveDevEntry fetches the probe path and returns the parsed entry", async () => {
  let requested = ""
  const fetchImpl = (async (url: string | URL | Request) => {
    requested = String(url)
    return new Response(REAL_BUN_PAGE, { status: 200 })
  }) as unknown as typeof fetch
  const entry = await resolveDevEntry(
    { port: 4321 },
    { probePath: "/__nifra/dev-entry", fetchImpl },
  )
  expect(requested).toBe("http://127.0.0.1:4321/__nifra/dev-entry")
  expect(entry.src).toBe("/_bun/client/.css-entry-000000004687f792.js")
})

test("a non-OK probe response reports the status, not a parse failure", async () => {
  // When the generated HTML route fails to build, Bun returns an error status. Reporting "could not find
  // the entry" there would point at this adapter instead of at the build error above it.
  const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
  await expect(resolveDevEntry({ port: 1 }, { probePath: "/p", fetchImpl })).rejects.toThrow(
    /returned 500/,
  )
})

test("an OK probe response with unrecognisable markup reports the shape change", async () => {
  const fetchImpl = (async () =>
    new Response("<html></html>", { status: 200 })) as unknown as typeof fetch
  await expect(resolveDevEntry({ port: 1 }, { probePath: "/p", fetchImpl })).rejects.toThrow(
    /could not find Bun's bundled client entry/,
  )
})
