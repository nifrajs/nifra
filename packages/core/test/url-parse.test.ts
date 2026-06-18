import { describe, expect, test } from "bun:test"
import { server } from "../src/index.ts"
import { pathnameOf, queryObjectOf, searchOf, urlPartsOf } from "../src/server/server.ts"

// AUDIT Perf-1: the request hot path no longer calls `new URL(req.url)`. `pathnameOf`/`searchOf`
// extract the path + query by substring, and `c.query` is parsed LAZILY (a `URLSearchParams` built
// on first read, or replaced by the validated value when a query schema is declared). These tests
// pin equivalence with WHATWG `new URL(req.url)` so the optimization can never silently diverge:
//   - the pathname is consumed RAW (handed to the router), so we assert byte-equivalence with
//     `.pathname` — including percent-encoded segments, which the router decodes per-param later.
//   - the query is consumed PARSED (fed to `URLSearchParams` for `c.query`), so we assert the parsed
//     params equal `.searchParams`. A lone trailing "?" serializes as "?" here vs "" in `.search`,
//     but both parse to the same empty params — parsed-level equivalence is the real contract.

// `req.url` is always an absolute, normalized URL in every supported runtime. Fragment shapes are
// included because Bun's `new Request(url).url` PRESERVES the fragment, so `req.url` can carry one —
// and a "?" that appears only inside the fragment is NOT a query (matches WHATWG).
const ABSOLUTE_URLS = [
  "http://localhost/",
  "http://localhost/a/b/c",
  "http://localhost/a/b/c?x=1&y=2",
  "http://localhost/users/42?tab=posts",
  "http://localhost/users/42?", // empty query
  "http://localhost/?a=1&a=2", // repeated key
  "http://localhost/search?q=a%20b", // percent-encoded value
  "http://localhost/a%20b/c", // percent-encoded path segment
  "http://127.0.0.1:8080/a/b?x=1", // host:port authority
  "https://example.com/deep/nested/path/here",
  "http://localhost/trailing/",
  "http://h/p#f", // fragment, no query
  "http://h/p?y=2#f", // query then fragment
  "http://h/p#f?x=1", // "?" lives inside the fragment → not a query
]

describe("pathnameOf / searchOf — equivalent to `new URL`, without the parse [AUDIT Perf-1]", () => {
  test.each(ABSOLUTE_URLS)("pathname of %s equals new URL().pathname", (url) => {
    expect(pathnameOf(url)).toBe(new URL(url).pathname)
    expect(urlPartsOf(url).pathname).toBe(new URL(url).pathname)
  })

  test.each(
    ABSOLUTE_URLS,
  )("query of %s parses to the same params as new URL().searchParams", (url) => {
    expect(Object.fromEntries(new URLSearchParams(searchOf(url)))).toEqual(
      Object.fromEntries(new URL(url).searchParams),
    )
    expect(Object.fromEntries(new URLSearchParams(urlPartsOf(url).search))).toEqual(
      Object.fromEntries(new URL(url).searchParams),
    )
  })

  test("urlPartsOf parses pathname and search together, preserving later question marks", () => {
    expect(urlPartsOf("http://host/search?q=a?b&limit=10#frag?ignored")).toEqual({
      pathname: "/search",
      search: "?q=a?b&limit=10",
    })
  })

  test.each([
    "?q=ada&limit=10",
    "?q=a?b&limit=10",
    "?a=1&a=2",
    "?x",
    "?=empty",
    "?a=1&&b=2&",
    "?__proto__=polluted&constructor=value",
    "?q=a+b",
    "?q=a%20b",
    "?bad=%E0%A4%A",
    "?",
    "",
  ])("queryObjectOf(%s) matches URLSearchParams semantics (repeats → arrays)", (search) => {
    const actual = queryObjectOf(search)
    // The reference contract: URLSearchParams pair iteration with repeated keys promoted to
    // arrays (audit 2026-06 — last-wins silently dropped values; an array query schema needs
    // them all). Single-occurrence keys stay plain strings.
    const expected: Record<string, string | string[]> = Object.create(null)
    for (const [key, value] of new URLSearchParams(search)) {
      const existing = expected[key]
      if (existing === undefined) expected[key] = value
      else if (typeof existing === "string") expected[key] = [existing, value]
      else existing.push(value)
    }
    expect(actual).toEqual(expected)
    // Hostile keys are inert own data keys on a null-prototype record — never the prototype,
    // never an inherited collision (`constructor` was a crash before the null-proto fix).
    expect(Object.getPrototypeOf(actual)).toBeNull()
    expect(Object.hasOwn(actual, "__proto__")).toBe(Object.hasOwn(expected, "__proto__"))
  })

  test("degrades gracefully on no-path + schemeless shapes (req.url is normally absolute)", () => {
    // No path component → "/", matching `new URL`.
    expect(pathnameOf("http://host")).toBe("/")
    expect(pathnameOf("http://host")).toBe(new URL("http://host").pathname)
    expect(searchOf("http://host")).toBe("")
    // Schemeless fallback (defensive — `req.url` carries a scheme): the first "/" opens the path.
    expect(pathnameOf("/relative/path?x=1")).toBe("/relative/path")
    expect(searchOf("/relative/path?x=1")).toBe("?x=1")
  })
})

describe("c.query — lazy parse wired through the server [AUDIT Perf-1]", () => {
  const echo = () =>
    server()
      .get("/", (c) => ({ where: "root", q: Object.fromEntries(c.query) }))
      .get("/a/b/c", (c) => ({ where: "abc", q: Object.fromEntries(c.query) }))
      .get("/users/:id", (c) => ({
        where: "user",
        id: c.params.id,
        q: Object.fromEntries(c.query),
      }))

  test.each([
    ["http://localhost/", "root"],
    ["http://localhost/a/b/c", "abc"],
    ["http://localhost/a/b/c?x=1&y=2", "abc"],
    ["http://localhost/users/42?tab=posts", "user"],
  ])("routes %s and exposes c.query matching new URL", async (url, where) => {
    const res = await echo().fetch(new Request(url))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { where: string; q: Record<string, string> }
    expect(body.where).toBe(where)
    expect(body.q).toEqual(Object.fromEntries(new URL(url).searchParams))
  })

  test("unmatched path → 404 (pathnameOf yields the same route key as new URL)", async () => {
    expect((await echo().fetch(new Request("http://localhost/missing"))).status).toBe(404)
  })

  test("repeated query keys: c.query.getAll matches new URL", async () => {
    const url = "http://localhost/a/b/c?a=1&a=2&a=3"
    const app = server().get("/a/b/c", (c) => ({ all: c.query.getAll("a") }))
    expect(await (await app.fetch(new Request(url))).json()).toEqual({
      all: new URL(url).searchParams.getAll("a"),
    })
  })

  test("c.query is memoized — repeated reads return the same instance (lazy getter caches)", async () => {
    let same = false
    const app = server().get("/c", (c) => {
      const a = c.query
      const b = c.query
      same = a === b
      return { same }
    })
    await app.fetch(new Request("http://localhost/c?x=1"))
    expect(same).toBe(true)
  })

  test("a fragment in req.url leaks into neither routing nor c.query", async () => {
    // Bun preserves the fragment in req.url; the path still matches and the in-fragment "?x=1" is
    // NOT a query — equivalent to new URL (pathname "/a/b/c", search "").
    const res = await echo().fetch(new Request("http://localhost/a/b/c#sec?x=1"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { where: string; q: Record<string, string> }
    expect(body.where).toBe("abc")
    expect(body.q).toEqual({})
  })
})
