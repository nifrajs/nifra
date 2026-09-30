import { expect, test } from "bun:test"
import {
  compileRoutePattern,
  type MixedPart,
  matchMixedSegment,
  matchRoutePattern,
  mixedSegmentShape,
  mixedSegmentSource,
} from "../src/router/pattern.ts"
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

test("an RPC-style terminal colon action remains a literal route", () => {
  const compiled = compileRoutePattern("/v1/things:batchGet")
  expect(compiled.segments[1]).toEqual({ kind: "static", value: "things:batchGet" })

  const router = routerOf("/v1/things:batchGet")
  expect(hit(router, "/v1/things:batchGet")).toEqual({
    payload: "/v1/things:batchGet",
    params: {},
  })
  expect(hit(router, "/v1/thingsDeleteAll")).toBeUndefined()
})

test("mixed siblings have deterministic shared specificity independent of registration order", () => {
  for (const patterns of [
    ["/bar.:value", "/:value.foo"],
    ["/:value.foo", "/bar.:value"],
  ]) {
    expect(hit(routerOf(...patterns), "/bar.foo")).toEqual({
      payload: "/bar.:value",
      params: { value: "foo" },
    })
  }
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

// ── One pass per segment ──────────────────────────────────────────────────────────────────────────
//
// A mixed shape reads as an anchored pattern with one lazy capture per parameter. The reference below
// compiles exactly that pattern; the scanner has to agree with it on every input, captures included,
// while never doing more than one pass over a segment.

const escapeForRegex = (value: string): string => value.replace(/[.*+?^()|[\]\\{}$]/g, "\\$&")

function referenceSegment(parts: readonly MixedPart[], segment: string): string[] | undefined {
  const match = new RegExp(`^${mixedSegmentSource(parts)}$`).exec(segment)
  return match === null ? undefined : match.slice(1)
}

function referencePath(pattern: string, path: string): Record<string, string> | undefined {
  const compiled = compileRoutePattern(pattern)
  const source = compiled.segments.map((segment) =>
    segment.kind === "static"
      ? escapeForRegex(segment.value)
      : segment.kind === "param"
        ? "([^/]+)"
        : segment.kind === "mixed"
          ? mixedSegmentSource(segment.parts)
          : "(.+)",
  )
  const match = new RegExp(`^/${source.join("/")}$`).exec(path)
  if (match === null) return undefined
  const params: Record<string, string> = {}
  compiled.paramNames.forEach((name, index) => {
    params[name] = match[index + 1] as string
  })
  return params
}

/** Deterministic generator, so a failure names a reproducible case. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A deliberately tiny alphabet: literals and parameter text collide constantly, which is where a
// wrong choice of literal occurrence would show.
const ALPHABET = ["a", "b", "-", "."]

function randomText(random: () => number, min: number, max: number): string {
  const length = min + Math.floor(random() * (max - min + 1))
  let text = ""
  for (let i = 0; i < length; i++) text += ALPHABET[Math.floor(random() * ALPHABET.length)]
  return text
}

/** A well-formed shape: at least one parameter, no empty literal, no two literals in a row. */
function randomShape(random: () => number): MixedPart[] {
  const parts: MixedPart[] = []
  const params = 1 + Math.floor(random() * 4)
  if (random() < 0.5) parts.push({ t: "lit", v: randomText(random, 1, 3) })
  for (let i = 0; i < params; i++) {
    parts.push({ t: "param", name: `p${i}` })
    const isLast = i === params - 1
    // Mostly a literal between parameters; sometimes none, so adjacent parameters are covered too.
    if (random() < (isLast ? 0.5 : 0.85)) parts.push({ t: "lit", v: randomText(random, 1, 3) })
  }
  // A single bare parameter is not a mixed segment.
  if (parts.length === 1) parts.push({ t: "lit", v: randomText(random, 1, 3) })
  return parts
}

/** Text built to fit the shape, so the comparison sees plenty of matches and not only misses. */
function fitting(random: () => number, parts: readonly MixedPart[]): string {
  return parts.map((part) => (part.t === "lit" ? part.v : randomText(random, 1, 4))).join("")
}

test("the scanner agrees with the anchored lazy pattern on every input", () => {
  const random = seeded(0x51f15e)
  let matches = 0
  let misses = 0
  for (let shape = 0; shape < 600; shape++) {
    const parts = randomShape(random)
    for (let sample = 0; sample < 60; sample++) {
      const segment = sample % 3 === 0 ? randomText(random, 0, 12) : fitting(random, parts)
      const expected = referenceSegment(parts, segment)
      // Pre-filled, so a miss that leaves captures behind - or a hit that overwrites - is caught.
      const out = ["kept"]
      const matched = matchMixedSegment(mixedSegmentShape(parts), segment, out)
      const label = `${JSON.stringify(parts)} against ${JSON.stringify(segment)}`
      if (expected === undefined) {
        misses++
        expect(`${matched} ${JSON.stringify(out)} ${label}`).toBe(`false ["kept"] ${label}`)
      } else {
        matches++
        expect(`${matched} ${JSON.stringify(out)} ${label}`).toBe(
          `true ${JSON.stringify(["kept", ...expected])} ${label}`,
        )
      }
    }
  }
  // Both outcomes have to be well represented or the comparison proves little.
  expect(matches).toBeGreaterThan(5000)
  expect(misses).toBeGreaterThan(5000)
})

test("the trie and matchRoutePattern agree with the whole-path pattern", () => {
  const random = seeded(0xc0ffee)
  const patterns = [
    "/f/:a-:b.json",
    "/:a.:b",
    "/v:major.:minor/x",
    "/api/:version/post-:id.html",
    "/p/:a:b.x",
    "/x/:a-:b-:c/:d.a/b",
    "/a.:x.b",
    "/:a--:b-:c",
  ]
  let matches = 0
  for (const pattern of patterns) {
    const router = routerOf(pattern)
    const compiled = compileRoutePattern(pattern)
    for (let sample = 0; sample < 1500; sample++) {
      const path =
        sample % 4 === 0
          ? `/${randomText(random, 0, 6)}/${randomText(random, 0, 8)}`
          : `/${compiled.segments
              .map((segment) =>
                segment.kind === "static"
                  ? segment.value
                  : segment.kind === "mixed"
                    ? random() < 0.85
                      ? fitting(random, segment.parts)
                      : randomText(random, 0, 8)
                    : randomText(random, 1, 4),
              )
              .join("/")}`
      const expected = referencePath(pattern, path)
      if (expected !== undefined) matches++
      const label = `${pattern} against ${path}`
      expect(`${JSON.stringify(hit(router, path)?.params)} ${label}`).toBe(
        `${JSON.stringify(expected)} ${label}`,
      )
      const direct = matchRoutePattern(compiled, path)
      expect(`${JSON.stringify(direct.matched ? direct.params : undefined)} ${label}`).toBe(
        `${JSON.stringify(expected)} ${label}`,
      )
    }
  }
  expect(matches).toBeGreaterThan(3000)
})

test("a wildcard after a mixed segment still takes the rest of the path", () => {
  const compiled = compileRoutePattern("/files/:name.:ext/*rest")
  expect(matchRoutePattern(compiled, "/files/a.b.c/x/y")).toEqual({
    matched: true,
    params: { name: "a", ext: "b.c", rest: "x/y" },
  })
  expect(matchRoutePattern(compiled, "/files/abc/x/y")).toEqual({
    matched: false,
    reason: "not-found",
  })
})

test("a miss that captured part of the segment leaves no value behind", () => {
  const parts = compileRoutePattern("/:a-:b.json").segments[0]
  if (parts?.kind !== "mixed") throw new Error("expected a mixed segment")
  const out = ["kept"]
  // `a` is captured, then nothing is left for `b`.
  expect(matchMixedSegment(mixedSegmentShape(parts.parts), "x-.json", out)).toBe(false)
  expect(out).toEqual(["kept"])
  // A leading and a trailing literal that overlap in the text are not a match.
  const overlap = compileRoutePattern("/a.:x.b").segments[0]
  if (overlap?.kind !== "mixed") throw new Error("expected a mixed segment")
  expect(matchMixedSegment(mixedSegmentShape(overlap.parts), "a.b", out)).toBe(false)
  expect(out).toEqual(["kept"])
})

test("matching a segment is one pass, however long it is and however many parameters", () => {
  // Request text decides the segment, so its length must only ever buy a linear amount of work. The
  // inputs below are the ones that make a backtracking matcher try every split between parameters:
  // long runs of the separator, of filler, and near misses of a longer separator, each with the
  // trailing literal present and absent. 64 KB is the largest path a supported runtime hands over.
  const size = 64 * 1024
  const shapes = [
    "/f/:a-:b.json",
    "/f/:a-:b-:c.json",
    "/f/:a-:b-:c-:d.json",
    "/f/:a-:b-:c-:d-:e-:f",
    "/f/:a--:b--:c--:d.json",
    "/f/:a:b:c.json",
    "/f/x:a.:b.:c.:d.y",
  ]
  const fills = ["-", "a", ".", "-a", "a-", "--a", ".-"]
  const paths: string[] = []
  for (const fill of fills) {
    const body = fill.repeat(Math.ceil(size / fill.length)).slice(0, size)
    for (const prefix of ["", "x"]) {
      for (const suffix of ["", ".json", ".jso", "y", "-"])
        paths.push(`/f/${prefix}${body}${suffix}`)
    }
  }

  const routers = shapes.map((shape) => routerOf(shape))
  const compiled = shapes.map((shape) => compileRoutePattern(shape))
  let answered = 0
  const started = performance.now()
  for (const path of paths) {
    for (let i = 0; i < shapes.length; i++) {
      routers[i]?.find("GET", path)
      matchRoutePattern(compiled[i] as ReturnType<typeof compileRoutePattern>, path)
      answered += 2
    }
  }
  const elapsed = performance.now() - started
  expect(answered).toBe(paths.length * shapes.length * 2)
  // 980 lookups over 64 KB each. One pass apiece is a few milliseconds in total; a matcher that
  // retries splits does not finish a single one of these in that time.
  expect(elapsed).toBeLessThan(2000)
})
