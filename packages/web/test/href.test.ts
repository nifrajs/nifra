import { expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { server } from "@nifrajs/core"
import { isSameOriginPath } from "@nifrajs/core/pattern"
import { type HrefRefusal, href, INERT_HREF, onHrefRefused, rawHref } from "../src/href.ts"
import { redirect } from "../src/internal/render-document.ts"
import type { Href } from "../src/navigation.ts"
import { createMatcher } from "../src/router.ts"
import { parseSearch, serializeSearch } from "../src/search.ts"

// `href` is typed against the generated route table, which this program leaves empty: these tests drive
// the runtime with any pattern. The typed surface is href-types.test.ts.
interface Options {
  readonly to: string
  readonly params?: Readonly<Record<string, string | undefined>>
  readonly search?: Record<string, unknown>
  readonly hash?: string | undefined
}
// The runtime accepts any pattern; the typed call is checked in href-types.test.ts.
const build = (options: Options): string => Reflect.apply(href, undefined, [options])

const ORIGIN = "https://app.test"

/** Values a link may be asked to carry. */
const VALUES = [
  "7",
  "a b",
  "a/b",
  "a?b=1",
  "a#b",
  "a%b",
  "100%",
  "%2F",
  "%2e%2e",
  "%252e",
  "a\\b",
  "\\evil.com",
  "/evil.com",
  "//evil.com",
  "https://evil.com",
  "javascript:alert(1)",
  "..%2f..%2fadmin",
  "a;b=c",
  "a\tb",
  "a\r\nb",
  "a\0b",
  "a b",
  "é",
  "日本語",
  "😀",
  "a.b",
  "a..b",
  "...",
  ".a",
  "x?y#z",
]
const REFUSED_AS_SEGMENT = ["", ".", "..", "\ud800", "a\udc00b"]

const app = server()
  .get("/", () => ({ route: "/" }))
  .get("/users/:id", (c) => ({ route: "/users/:id", params: { id: c.params.id } }))
  .get("/orgs/:org/repos/:repo", (c) => ({
    route: "/orgs/:org/repos/:repo",
    params: { org: c.params.org, repo: c.params.repo },
  }))
  .get("/docs/*slug", (c) => ({ route: "/docs/*slug", params: { slug: c.params.slug } }))

async function served(path: string): Promise<{ route: string; params?: Record<string, string> }> {
  const response = await app.fetch(new Request(`${ORIGIN}${path}`))
  expect(response.status).toBe(200)
  return response.json()
}

const matchesClient = createMatcher([
  { pattern: "/", routeId: "/" },
  { pattern: "/users/:id", routeId: "/users/:id" },
  { pattern: "/orgs/:org/repos/:repo", routeId: "/orgs/:org/repos/:repo" },
  { pattern: "/docs/*slug", routeId: "/docs/*slug" },
])

test("builds the URL for a route: params, then search, then hash", () => {
  expect(build({ to: "/" })).toBe("/")
  expect(build({ to: "/users/:id", params: { id: "7" } })).toBe("/users/7")
  expect(
    build({ to: "/users/:id", params: { id: "a b" }, search: { tab: "posts" }, hash: "top" }),
  ).toBe("/users/a%20b?tab=posts#top")
  expect(build({ to: "/orgs/:org/repos/:repo", params: { org: "acme", repo: "web" } })).toBe(
    "/orgs/acme/repos/web",
  )
  expect(build({ to: "/docs/*slug", params: { slug: "guide/intro" } })).toBe("/docs/guide/intro")
  expect(build({ to: "/café/:id", params: { id: "7" } })).toBe("/caf%C3%A9/7")
})

test("I1: every value that is accepted builds a same-origin path with one leading slash, the rest the inert one", () => {
  for (const to of ["/u/:id", "/:a/:b", "/*path", "/docs/*slug", "/files/:name.pdf"]) {
    const params = (value: string): Record<string, string> =>
      to === "/:a/:b"
        ? { a: value, b: value }
        : { id: value, name: value, path: value, slug: value }
    for (const value of [...VALUES, ...REFUSED_AS_SEGMENT]) {
      const built = logged(() => build({ to, params: params(value) })).result
      if (built === INERT_HREF) continue
      expect(isSameOriginPath(built)).toBe(true)
      expect(built.startsWith("//")).toBe(false)
      expect(new URL(built, ORIGIN).origin).toBe(ORIGIN)
    }
  }
})

test("I2: a value is one path segment, whatever it holds", () => {
  expect(build({ to: "/u/:id", params: { id: "a/b?c#d" } })).toBe("/u/a%2Fb%3Fc%23d")
  expect(build({ to: "/u/:id", params: { id: "%2F" } })).toBe("/u/%252F")
  expect(build({ to: "/u/:id", params: { id: "\\evil.com" } })).toBe("/u/%5Cevil.com")
  expect(build({ to: "/u/:id", params: { id: "//evil.com" } })).toBe("/u/%2F%2Fevil.com")
  expect(build({ to: "/u/:id", params: { id: "日本語" } })).toBe("/u/%E6%97%A5%E6%9C%AC%E8%AA%9E")
})

/** What `call` returns and the refusals it reported, every one (the default log writes each text once). */
function logged<T>(call: () => T): { readonly result: T; readonly lines: readonly string[] } {
  const lines: string[] = []
  const stop = onHrefRefused((refusal) => lines.push(refusal.message))
  try {
    return { result: call(), lines }
  } finally {
    stop()
  }
}

test("I3: a missing, empty or unspellable param is refused with a log naming it and the pattern", () => {
  const message = (options: Options): string => {
    const { result, lines } = logged(() => build(options))
    expect(result).toBe(INERT_HREF)
    expect(lines).toHaveLength(1)
    return lines[0] ?? ""
  }
  expect(message({ to: "/users/:id" })).toBe(
    '[nifra/web] href({ to: "/users/:id" }): "id" is missing or empty',
  )
  expect(message({ to: "/users/:id", params: { id: "" } })).toContain('"id" is missing or empty')
  expect(message({ to: "/users/:id", params: { id: undefined } })).toContain(
    '"id" is missing or empty',
  )
  expect(message({ to: "/orgs/:org/repos/:repo", params: { org: "acme" } })).toContain('"repo"')
  for (const bad of [".", "..", "\ud800"]) {
    const text = message({ to: "/users/:id", params: { id: bad } })
    expect(text).toContain('"id"')
    expect(text).toContain('"/users/:id"')
    expect(text).not.toContain(bad === "\ud800" ? "ud800" : `: ${bad}`)
  }
  expect(message({ to: "/docs/*slug", params: { slug: "a/../b" } })).toContain('"slug"')
})

test("the default log writes each distinct refusal once, and a reporter hears every one in its place", () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    for (let row = 0; row < 3; row++) build({ to: "/dedupe-a/:id", params: { id: "" } })
    build({ to: "/dedupe-b/:id", params: { id: "" } })
    expect(errors).toHaveBeenCalledTimes(2)
    errors.mockClear()
    const heard: HrefRefusal[] = []
    const stop = onHrefRefused((refusal) => heard.push(refusal))
    try {
      for (let row = 0; row < 3; row++) build({ to: "/dedupe-a/:id", params: { id: "" } })
      rawHref("//evil.example")
    } finally {
      stop()
    }
    expect(errors).not.toHaveBeenCalled()
    expect(heard.map((refusal) => [refusal.call, refusal.route])).toEqual([
      ["href", "/dedupe-a/:id"],
      ["href", "/dedupe-a/:id"],
      ["href", "/dedupe-a/:id"],
      ["rawHref", undefined],
    ])
    // Removed, the default log is back (and has already seen this text).
    build({ to: "/dedupe-c/:id", params: { id: "" } })
    expect(errors).toHaveBeenCalledTimes(1)
  } finally {
    errors.mockRestore()
  }
})

test("a second reporter replaces the first, a stale remover leaves it alone, a throwing one costs no link", () => {
  const first: string[] = []
  const second: string[] = []
  const removeFirst = onHrefRefused((refusal) => first.push(refusal.message))
  const removeSecond = onHrefRefused((refusal) => second.push(refusal.message))
  try {
    removeFirst()
    expect(build({ to: "/replace/:id" })).toBe(INERT_HREF)
    expect(first).toEqual([])
    expect(second).toHaveLength(1)
  } finally {
    removeSecond()
  }
  const removeThrowing = onHrefRefused(() => {
    throw new Error("reporter down")
  })
  try {
    expect(build({ to: "/replace/:id" })).toBe(INERT_HREF)
  } finally {
    removeThrowing()
  }
})

test("the refused value is a same-origin check failure, and a plain anchor resolves to no route", () => {
  expect(isSameOriginPath(INERT_HREF)).toBe(false)
  const url = new URL(INERT_HREF, ORIGIN)
  expect(url.origin).toBe(ORIGIN)
  expect(url.pathname).toBe("/%01nifra-invalid-href")
})

test("href refuses adjacent params whose values would change or become malformed", () => {
  for (const a of ["hello", "é", " ", "%", "😀"])
    expect(logged(() => build({ to: "/:a:b.txt", params: { a, b: "world" } })).result).toBe(
      INERT_HREF,
    )
  const params = { a: "h", b: "é world" }
  const path = build({ to: "/:a:b.txt", params })
  expect(path).toBe("/h%C3%A9%20world.txt")
  expect(createMatcher([{ pattern: "/:a:b.txt", routeId: "adjacent" }])(path)).toEqual({
    routeId: "adjacent",
    params,
  })
})

test("I3: it refuses in production too, because no branch of it reads the environment", () => {
  const before = process.env.NODE_ENV
  process.env.NODE_ENV = "production"
  try {
    expect(logged(() => build({ to: "/users/:id" })).result).toBe(INERT_HREF)
    expect(logged(() => rawHref("//evil.com")).result).toBe(INERT_HREF)
  } finally {
    if (before === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = before
  }
  const source = readFileSync(new URL("../src/href.ts", import.meta.url), "utf8")
  expect(source).not.toMatch(/NODE_ENV|process\.env|import\.meta\.env/)
})

test("I4: the same input builds the same string, before and after the pattern cache starts over", () => {
  const first = build({ to: "/users/:id", params: { id: "a b" }, search: { q: "x" }, hash: "h" })
  for (let i = 0; i < 3000; i++) build({ to: `/p${i}/:id`, params: { id: String(i) } })
  expect(build({ to: "/p17/:id", params: { id: "17" } })).toBe("/p17/17")
  expect(build({ to: "/p2999/:id", params: { id: "2999" } })).toBe("/p2999/2999")
  expect(build({ to: "/users/:id", params: { id: "a b" }, search: { q: "x" }, hash: "h" })).toBe(
    first,
  )
})

test("I5: a built URL reaches its route with exactly the values it was built from", async () => {
  const cases: Array<{ to: string; params: Record<string, string>; route: string }> = [
    { to: "/users/:id", params: { id: "a/b?c#d" }, route: "/users/:id" },
    { to: "/users/:id", params: { id: "100%" }, route: "/users/:id" },
    { to: "/users/:id", params: { id: "%2F" }, route: "/users/:id" },
    { to: "/users/:id", params: { id: "日本語 😀" }, route: "/users/:id" },
    {
      to: "/orgs/:org/repos/:repo",
      params: { org: "a b", repo: "x/y" },
      route: "/orgs/:org/repos/:repo",
    },
  ]
  for (const value of VALUES)
    cases.push({ to: "/users/:id", params: { id: value }, route: "/users/:id" })
  for (const { to, params, route } of cases) {
    const path = build({ to, params, search: { page: 2, q: "a b&c" }, hash: "top" })
    const url = new URL(path, ORIGIN)
    const reached = await served(url.pathname + url.search)
    expect(reached.route).toBe(route)
    expect(reached.params).toEqual(params)
    const client = matchesClient(url.pathname + url.search)
    expect(client?.routeId).toBe(route)
    expect(client?.params).toEqual(params)
    expect(parseSearch(url.search.slice(1))).toEqual({ page: 2, q: "a b&c" })
    expect(url.hash).toBe("#top")
  }
})

test("I5: a wildcard value reaches its route one segment at a time", async () => {
  for (const slug of ["intro", "guide/intro", "a b/c d", "é/😀", "100%/x"]) {
    const path = build({ to: "/docs/*slug", params: { slug } })
    expect((await served(path)).params).toEqual({ slug })
    expect(matchesClient(path)?.params).toEqual({ slug })
  }
  expect(logged(() => build({ to: "/docs/*slug", params: { slug: "a/../b" } })).result).toBe(
    INERT_HREF,
  )
  expect(logged(() => build({ to: "/docs/*slug", params: { slug: "" } })).result).toBe(INERT_HREF)
})

test("I6: search is serialized exactly as the router reads it, and an empty one adds nothing", () => {
  const search = { page: 2, q: "a b&c", tags: ["x", "y"], on: true }
  expect(build({ to: "/r", search })).toBe(`/r${serializeSearch(search)}`)
  expect(build({ to: "/r", search: {} })).toBe("/r")
  expect(build({ to: "/r" })).toBe("/r")
  expect(parseSearch(build({ to: "/r", search }).slice(3))).toEqual(search)
})

test("the hash is encoded as a fragment, and left off when empty", () => {
  expect(build({ to: "/r", hash: "top" })).toBe("/r#top")
  expect(build({ to: "/r", hash: "" })).toBe("/r")
  expect(build({ to: "/r", hash: undefined })).toBe("/r")
  expect(build({ to: "/r", search: { a: 1 }, hash: "a b" })).toBe("/r?a=1#a%20b")
  for (const hash of ["a\r\nb", "a\\b", "//evil.com", "a\tb", "é", "😀", "a?b#c"]) {
    const built = build({ to: "/r", hash })
    expect(isSameOriginPath(built)).toBe(true)
    expect(new URL(built, ORIGIN).origin).toBe(ORIGIN)
  }
  const surrogate = logged(() => build({ to: "/r", hash: "\ud800" }))
  expect(surrogate.result).toBe(INERT_HREF)
  expect(surrogate.lines.join()).toContain("unpaired surrogate")
})

test("route-slot keys are reserved only in query text and flat slot targets are composed", () => {
  expect(build({ to: "/a&slot.side=/users/7" })).toBe("/a&slot.side=/users/7")
  const reserved = logged(() =>
    Reflect.apply(href, undefined, [
      { to: "/users/:id", params: { id: "7" }, search: { "slot.side": "/users/8" } },
    ]),
  )
  expect(reserved.result).toBe(INERT_HREF)
  expect(reserved.lines.join()).toContain("reserved for route-slot state")

  expect(
    Reflect.apply(href, undefined, [
      { to: "/dashboard", slots: { side: "/users/7", closed: null } },
    ]),
  ).toBe("/dashboard?slot.side=%2Fusers%2F7")
  expect(Reflect.apply(href, undefined, [{ to: "/dashboard", slots: {} }])).toBe("/dashboard")
})

test("I7: rawHref accepts exactly what isSameOriginPath accepts, and returns it as written", () => {
  const accepted = [
    "/",
    "/a",
    "/a/b?x=1",
    "/a?b=1#c",
    "/llms.txt",
    "/caf%C3%A9",
    "/a b",
    "/a/../b",
    "/%5Cx",
  ]
  for (const path of accepted) {
    expect(isSameOriginPath(path)).toBe(true)
    expect<string>(rawHref(path)).toBe(path)
  }
  const refused = [
    "",
    "a",
    "./a",
    "//evil.com",
    "/\\evil.com",
    "/\\\\evil.com/x",
    "https://evil.com",
    "javascript:alert(1)",
    "/\t/evil.example",
    "/\r/evil.example",
    "/\n/evil.example",
    "/a\0b",
    "/a\u007fb",
    "/.//evil.example/x",
    "/a/..//evil.example/x",
    "/%2e//evil.example/x",
    " /a",
  ]
  for (const path of refused) {
    expect(isSameOriginPath(path)).toBe(false)
    expect(logged(() => rawHref(path)).result).toBe(INERT_HREF)
  }
  for (const notAString of [5, null, undefined, {}, ["/a"]]) {
    // A caller without types hands rawHref anything.
    expect(logged(() => Reflect.apply(rawHref, undefined, [notAString])).result).toBe(INERT_HREF)
  }
  // The log leaves the value out: a CMS link can carry a token.
  const refused_ = logged(() => rawHref("//evil.com?token=secret"))
  expect(refused_.lines).toHaveLength(1)
  expect(refused_.lines[0]).toContain("not a same-origin one")
  expect(refused_.lines[0]).not.toContain("secret")
  expect(refused_.lines[0]).not.toContain("evil.com")
})

test("I9: redirect() checks an Href like any string, so a forged one cannot leave the origin", () => {
  expect(() => redirect(logged(() => rawHref("//evil.com")).result)).toThrow(/nowhere to send/)
  expect(redirect(href_("/users/7")).plain?.headers?.location).toBe("/users/7")
  expect(redirect(rawHref("/llms.txt")).plain?.headers?.location).toBe("/llms.txt")
  for (const forged of ["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)"]) {
    expect(() => redirect(forge(forged))).toThrow(/same-origin/)
  }
  // A line break reaches no Location header, even when the caller opts out of the origin check.
  expect(() => redirect(forge("/a\r\nSet-Cookie: x=1"), { external: true })).toThrow(/CR\/LF/)
})

test("redirect() sends a refused location to its fallback, and throws without a usable one", () => {
  const inert = logged(() => rawHref("//evil.example")).result
  expect(() => redirect(inert)).toThrow(/nowhere to send the visitor/)
  expect(() => redirect(inert, { fallback: inert })).toThrow(/nowhere to send the visitor/)
  const sent = redirect(inert, { fallback: href_("/"), status: 307 })
  expect(sent.plain?.headers?.location).toBe("/")
  expect(sent.plain?.status).toBe(307)
  // A fallback is checked like any location; a good location ignores it.
  expect(() => redirect(inert, { fallback: forge("//evil.com") })).toThrow(/same-origin/)
  expect(redirect(href_("/users/7"), { fallback: href_("/") }).plain?.headers?.location).toBe(
    "/users/7",
  )
})

function href_(path: string): Href {
  return rawHref(path)
}

function forge(value: string): Href {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the point of the test is a value no href() or rawHref() call made
  return value as Href
}
