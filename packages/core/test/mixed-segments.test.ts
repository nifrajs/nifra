import { expect, test } from "bun:test"
import { compileRoutePattern, matchRoutePattern } from "../src/router/pattern.ts"
import { Router } from "../src/router/router.ts"

const routerOf = (...patterns: string[]): Router<string> => {
  const router = new Router<string>()
  for (const pattern of patterns) router.add("GET", pattern, pattern)
  return router
}
const hit = (router: Router<string>, path: string) => {
  const match = router.find("GET", path)
  return match.found ? { payload: match.payload, params: match.params } : undefined
}

test("a mixed segment captures the variable part and pins the literal", () => {
  // The trigger: IndexNow requires the key file at `<origin>/<key>.txt`, at the ROOT, where the key
  // is deploy-time config. So the filename is genuinely part literal, part variable.
  const router = routerOf("/:key.txt")
  expect(hit(router, "/abc123.txt")).toEqual({ payload: "/:key.txt", params: { key: "abc123" } })
  expect(hit(router, "/abc.json")).toBeUndefined()
  expect(hit(router, "/abc.txt/x")).toBeUndefined() // one segment only
})

test("the capture is lazy but the anchor still forces the last literal", () => {
  // A GREEDY capture would swallow the trailing literal and then fail to match it. A lazy one plus
  // `^…$` gives the intuitive answer on both.
  const router = routerOf("/:key.txt")
  expect(hit(router, "/abc.txt.txt")?.params).toEqual({ key: "abc.txt" })
})

test("a mixed parameter never captures the empty string", () => {
  // Same rule as a bare `:param`: matching would hand a handler `key: ""` and downstream code a
  // `WHERE id = ''` class of bug. `+?` and not `*?` is what enforces it, which is easy to get wrong.
  expect(hit(routerOf("/:key.txt"), "/.txt")).toBeUndefined()
  expect(hit(routerOf("/pre-:id"), "/pre-")).toBeUndefined()
})

test("precedence is static > mixed > param, independent of registration order", () => {
  // Registered param-first, so a registration-order implementation would pick the wrong one.
  const router = routerOf("/jobs/:id", "/jobs/:id.txt")
  expect(hit(router, "/jobs/a.txt")).toEqual({ payload: "/jobs/:id.txt", params: { id: "a" } })
  // Not matching the literal falls back to the bare param, which captures the whole segment.
  expect(hit(router, "/jobs/a.json")).toEqual({ payload: "/jobs/:id", params: { id: "a.json" } })

  const withStatic = routerOf("/:key.txt", "/robots.txt")
  expect(hit(withStatic, "/robots.txt")).toEqual({ payload: "/robots.txt", params: {} })
})

test("sibling mixed shapes at one level pick the right one", () => {
  // The trie holds ONE dynamic child per node for params; several mixed children at a level are a
  // legitimate shape, not a conflict.
  const router = routerOf("/:id.txt", "/:id.json")
  expect(hit(router, "/a.json")).toEqual({ payload: "/:id.json", params: { id: "a" } })
  expect(hit(router, "/a.txt")).toEqual({ payload: "/:id.txt", params: { id: "a" } })
})

test("several parameters in one segment capture left to right", () => {
  expect(hit(routerOf("/:a.:b"), "/x.y")?.params).toEqual({ a: "x", b: "y" })
  expect(hit(routerOf("/v:major.:minor/x"), "/v1.2/x")?.params).toEqual({
    major: "1",
    minor: "2",
  })
})

test("a failed mixed branch unwinds every value it pushed", () => {
  // A mixed segment pushes N values, not one. If the failed-branch unwind popped a single value,
  // the next branch's parameters would read values from the abandoned one - so this asserts the
  // deeper route still gets exactly its own params after a sibling dead-ends.
  const router = routerOf("/:a.:b/leaf", "/:only.txt/other")
  expect(hit(router, "/x.y/leaf")?.params).toEqual({ a: "x", b: "y" })
  expect(hit(router, "/q.txt/other")?.params).toEqual({ only: "q" })
})

test("literal and mixed segments compose with params and wildcards", () => {
  const router = routerOf("/api/:version/post-:id.html", "/files/*rest")
  expect(hit(router, "/api/v2/post-42.html")?.params).toEqual({ version: "v2", id: "42" })
  expect(hit(router, "/files/a/b/c")?.params).toEqual({ rest: "a/b/c" })
})

test("percent-encoded captures decode, malformed ones report malformed", () => {
  const compiled = compileRoutePattern("/:key.txt")
  expect(matchRoutePattern(compiled, "/a%2Fb.txt")).toEqual({
    matched: true,
    params: { key: "a/b" },
  })
  expect(matchRoutePattern(compiled, "/a%ZZ.txt")).toEqual({
    matched: false,
    reason: "malformed",
  })
})

test("a segment containing ':' after the first character is now a parameter", () => {
  // BEHAVIOUR CHANGE. `pre-:id` used to compile to a literal static segment matching only the exact
  // text "pre-:id"; it is now part literal, part parameter. That is what makes `/post-:id.html`
  // work, and it is the one case where this feature is NOT purely additive - a route relying on a
  // literal colon mid-segment (`/v1/things:batchGet`) changes meaning.
  const compiled = compileRoutePattern("/a/pre-:id")
  expect(compiled.paramNames).toEqual(["id"])
  expect(matchRoutePattern(compiled, "/a/pre-42")).toEqual({ matched: true, params: { id: "42" } })

  // A colon NOT followed by a valid name start stays literal, so `:` alone is still safe text.
  const literal = compileRoutePattern("/a/ratio:2")
  expect(literal.paramNames).toEqual([])
  expect(matchRoutePattern(literal, "/a/ratio:2").matched).toBe(true)
})

test("a mixed-free route table allocates no mixed children", () => {
  // The hot path must stay free: an app that never registers a mixed segment pays nothing beyond one
  // `undefined` check.
  const router = routerOf("/", "/users/:id", "/files/*rest", "/about")
  const roots = (router as unknown as { root: { mixedChildren?: unknown } }).root
  const walk = (node: Record<string, unknown>): number => {
    let count = node.mixedChildren === undefined ? 0 : 1
    for (const child of (node.staticChildren as Map<string, Record<string, unknown>>).values()) {
      count += walk(child)
    }
    for (const key of ["paramChild", "wildcardChild"]) {
      const child = node[key] as Record<string, unknown> | undefined
      if (child !== undefined) count += walk(child)
    }
    return count
  }
  expect(walk(roots as unknown as Record<string, unknown>)).toBe(0)
})
