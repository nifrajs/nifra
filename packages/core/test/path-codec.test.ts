import { expect, test } from "bun:test"
import {
  browserPathSegment,
  decodePathSegment,
  encodePathSegment,
  fillRoutePath,
} from "../src/router/pattern.ts"
import { needsResolving } from "../src/server/request-target.ts"
import {
  passThroughMismatches,
  rawCharacters,
  refusalMismatches,
  segmentMismatches,
} from "./path-codec-matrix.ts"

test("encodePathSegment holds every property over all ASCII and the samples", () => {
  expect(segmentMismatches(encodePathSegment, "canonical")).toEqual([])
})

test("browserPathSegment is the parser's own spelling", () => {
  expect(segmentMismatches(browserPathSegment, "browser")).toEqual([])
})

test("values no segment can carry throw, near misses do not", () => {
  expect(refusalMismatches(encodePathSegment)).toEqual([])
  expect(refusalMismatches(browserPathSegment)).toEqual([])
})

test("the characters left as written are pinned", () => {
  expect(rawCharacters(encodePathSegment)).toBe(
    "!$&'()*+,-.0123456789:=@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~",
  )
  expect(rawCharacters(browserPathSegment)).toBe(
    "!$&'()*+,-.0123456789:;=@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]_abcdefghijklmnopqrstuvwxyz|~",
  )
})

// A gate that cannot fail proves nothing: the encoders this module replaced must trip it.
test("the checks fail on the encoders the codec replaced", () => {
  expect(segmentMismatches((value) => encodeURIComponent(value), "canonical")).not.toEqual([])
  const encodeUri = (value: string): string =>
    encodeURI(value).replace(/[?#]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  expect(segmentMismatches(encodeUri, "browser")).not.toEqual([])
  expect(refusalMismatches((value) => encodeURIComponent(value))).not.toEqual([])
})

// request-target.ts is vendored into the Node and Deno adapters, so it cannot import the codec.
// This ties the two definitions of "a character the parser rewrites in a path" together instead.
test("needsResolving flags exactly the characters the browser spelling encodes", () => {
  const drifted: string[] = []
  for (let code = 0; code < 128; code++) {
    const char = String.fromCharCode(code)
    if ("/?#%".includes(char)) continue
    const value = `a${char}b`
    const encodes = browserPathSegment(value) !== value
    if (needsResolving(`/${value}`) !== encodes) drifted.push(`U+00${code.toString(16)}`)
  }
  expect(drifted).toEqual([])
})

test("decodePathSegment is the inverse, and says undefined for a malformed escape", () => {
  expect(decodePathSegment("plain")).toBe("plain")
  expect(decodePathSegment("a%2Fb%20c")).toBe("a/b c")
  expect(decodePathSegment("%E0%A4%A")).toBeUndefined()
  expect(decodePathSegment("%")).toBeUndefined()
  for (const value of ["é", "a;b", "100%", "😀", "a/b"]) {
    expect(decodePathSegment(encodePathSegment(value))).toBe(value)
    expect(decodePathSegment(browserPathSegment(value))).toBe(value)
  }
})

test("fillRoutePath spells params and reports what it cannot", () => {
  expect(fillRoutePath("/users/:id", { id: "7" })).toEqual({ ok: true, path: "/users/7" })
  expect(fillRoutePath("/blog/:year/:slug", { year: "2026", slug: "hi" })).toEqual({
    ok: true,
    path: "/blog/2026/hi",
  })
  expect(fillRoutePath("/blog/:slug", { slug: "../../escape hatch" })).toEqual({
    ok: true,
    path: "/blog/..%2F..%2Fescape%20hatch",
  })
  expect(fillRoutePath("/", {})).toEqual({ ok: true, path: "/" })
  expect(fillRoutePath("/café/:id", { id: "7" })).toEqual({ ok: true, path: "/caf%C3%A9/7" })
  expect(fillRoutePath("/a/:b/", { b: "x" })).toEqual({ ok: true, path: "/a/x/" })
  expect(fillRoutePath("/users/:id", {})).toEqual({ ok: false, missing: ["id"], invalid: [] })
  expect(fillRoutePath("/users/:id", { id: "" })).toEqual({
    ok: false,
    missing: ["id"],
    invalid: [],
  })
  expect(fillRoutePath("/blog/:slug", { slug: ".." })).toEqual({
    ok: false,
    missing: [],
    invalid: ["slug"],
  })
  expect(fillRoutePath("/u/:id", { id: "\ud800" })).toEqual({
    ok: false,
    missing: [],
    invalid: ["id"],
  })
})

test("fillRoutePath ignores inherited values", () => {
  const inherited: Record<string, string> = Object.create({ id: "7" })
  expect(fillRoutePath("/users/:id", inherited)).toEqual({
    ok: false,
    missing: ["id"],
    invalid: [],
  })
  expect(fillRoutePath("/users/:toString", {})).toEqual({
    ok: false,
    missing: ["toString"],
    invalid: [],
  })
})

test("fillRoutePath fills wildcard and mixed segments", () => {
  expect(fillRoutePath("/docs/*slug", { slug: "a/b c/d" })).toEqual({
    ok: true,
    path: "/docs/a/b%20c/d",
  })
  expect(fillRoutePath("/docs/*slug", { slug: "a//b/" })).toEqual({ ok: true, path: "/docs/a/b" })
  expect(fillRoutePath("/docs/*slug", { slug: "a/../b" })).toEqual({
    ok: false,
    missing: [],
    invalid: ["slug"],
  })
  expect(fillRoutePath("/docs/*slug", { slug: "/" })).toEqual({
    ok: false,
    missing: ["slug"],
    invalid: [],
  })
  expect(fillRoutePath("/files/:name.:ext", { name: "report", ext: "pdf" })).toEqual({
    ok: true,
    path: "/files/report.pdf",
  })
  expect(fillRoutePath("/p/post-:id", { id: "a b" })).toEqual({ ok: true, path: "/p/post-a%20b" })
})

test("fillRoutePath refuses a mixed-segment value the router would cut differently", () => {
  expect(fillRoutePath("/files/:name.:ext", { name: "a.b", ext: "c" })).toEqual({
    ok: false,
    missing: [],
    invalid: ["name"],
  })
  expect(fillRoutePath("/files/:name.:ext", { name: "a", ext: "b.c" })).toEqual({
    ok: true,
    path: "/files/a.b.c",
  })
  expect(fillRoutePath("/files/:name.:ext", { name: ".a", ext: "c" })).toEqual({
    ok: true,
    path: "/files/.a.c",
  })
  expect(fillRoutePath("/p/post-:id", { id: "post-1" })).toEqual({
    ok: true,
    path: "/p/post-post-1",
  })
})

// A leading empty piece would make `//host`, a protocol-relative URL to another origin.
test("fillRoutePath never produces a path that leaves the origin", () => {
  for (const value of ["/evil.com", "//evil.com", "\\evil.com", "/\\evil.com", "evil.com/"]) {
    for (const pattern of ["/*rest", "/:p", "/x/*rest"]) {
      const filled = fillRoutePath(pattern, { rest: value, p: value })
      if (!filled.ok) continue
      expect(filled.path.startsWith("//")).toBe(false)
      expect(new URL(filled.path, "https://app.test").origin).toBe("https://app.test")
    }
  }
})

test("Bun hands every spelling to the handler unchanged", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => new Response(new URL(request.url).pathname),
  })
  try {
    if (server.port === undefined) throw new Error("the server has no port")
    expect(await passThroughMismatches(server.port)).toEqual([])
  } finally {
    server.stop(true)
  }
})
