/**
 * A path built from a value reaches the route it names with exactly that value, or is refused when
 * building it. Every hostile value goes through the real router; a path built by splicing the same
 * values in raw is held to the same check and has to fail it, so the check can tell the two apart.
 */
import { expect, test } from "bun:test"
import { server } from "../src/index.ts"
import {
  compileRoutePattern,
  encodePathSegment,
  fillRoutePath,
  matchRoutePattern,
} from "../src/router/pattern.ts"
import { hostileValues } from "./path-codec-matrix.ts"

const ORIGIN = "http://app.test"

const app = server()
  .get("/", () => ({ route: "/" }))
  .get("/u/:id", (c) => ({ route: "/u/:id", params: { id: c.params.id } }))
  .get("/u/admin", () => ({ route: "/u/admin" }))
  .get("/admin", () => ({ route: "/admin" }))
  .get("/admin/secret", () => ({ route: "/admin/secret" }))
  .get("/o/:org/p/:proj", (c) => ({
    route: "/o/:org/p/:proj",
    params: { org: c.params.org, proj: c.params.proj },
  }))
  .get("/docs/*slug", (c) => ({ route: "/docs/*slug", params: { slug: c.params.slug } }))

interface Answer {
  readonly route: string
  readonly params?: Record<string, string>
}

async function reaches(path: string, expected: Answer): Promise<string | undefined> {
  const response = await app.fetch(new Request(`${ORIGIN}${path}`))
  if (response.status !== 200) return `${path} answered ${response.status}`
  const got: Answer = await response.json()
  return JSON.stringify(got) === JSON.stringify(expected)
    ? undefined
    : `${path} reached ${JSON.stringify(got)}`
}

const VALUES = hostileValues()
const refusedAsSegment = (value: string): boolean => value === "" || value === "." || value === ".."
const wildcardPieces = (value: string): string[] => value.split("/").filter((piece) => piece !== "")
const refusedAsWildcard = (value: string): boolean => {
  const pieces = wildcardPieces(value)
  return pieces.length === 0 || pieces.some((piece) => piece === "." || piece === "..")
}

function filled(pattern: string, params: Record<string, string>): string | undefined {
  const result = fillRoutePath(pattern, params)
  return result.ok ? result.path : undefined
}

test("a built path reaches its route with its value, for every hostile value", async () => {
  const failures: string[] = []
  for (const value of VALUES) {
    const one = filled("/u/:id", { id: value })
    const two = filled("/o/:org/p/:proj", { org: value, proj: value })
    const wild = filled("/docs/*slug", { slug: value })
    if ((one === undefined) !== refusedAsSegment(value))
      failures.push(`/u/:id refusal for ${JSON.stringify(value)}`)
    if ((two === undefined) !== refusedAsSegment(value))
      failures.push(`/o/:org refusal for ${JSON.stringify(value)}`)
    if ((wild === undefined) !== refusedAsWildcard(value))
      failures.push(`/docs refusal for ${JSON.stringify(value)}`)
    if (one !== undefined) {
      const miss = await reaches(one, { route: "/u/:id", params: { id: value } })
      if (miss !== undefined) failures.push(miss)
    }
    if (two !== undefined) {
      const miss = await reaches(two, {
        route: "/o/:org/p/:proj",
        params: { org: value, proj: value },
      })
      if (miss !== undefined) failures.push(miss)
    }
    if (wild !== undefined) {
      const slug = wildcardPieces(value).join("/")
      const miss = await reaches(wild, { route: "/docs/*slug", params: { slug } })
      if (miss !== undefined) failures.push(miss)
    }
  }
  expect(failures).toEqual([])
})

// The same check on a path with the value spliced in raw: it has to find failures, or it proves nothing.
test("the check fails on a value spliced in raw", async () => {
  const failures: string[] = []
  for (const value of VALUES) {
    // Only controls and space are escaped, the minimum for a request line to be sendable at all.
    const spliced = [...value]
      .map((char) =>
        char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f ? encodeURIComponent(char) : char,
      )
      .join("")
    const miss = await reaches(`/u/${spliced}`, { route: "/u/:id", params: { id: value } })
    if (miss !== undefined) failures.push(miss)
  }
  expect(failures.length).toBeGreaterThan(20)
  expect(failures.some((miss) => miss.includes('"route":"/admin"'))).toBe(true)
})

// A mixed segment is cut where the router finds the separator first. fillRoutePath accepts a value
// exactly when the router would cut it back into the same params: no needless refusal, no wrong cut.
test("a mixed segment is built exactly when the router reads the same params back", () => {
  const shapes: Array<{ pattern: string; names: string[]; join: (values: string[]) => string }> = [
    { pattern: "/f/:name.:ext", names: ["name", "ext"], join: ([a, b]) => `/f/${a}.${b}` },
    { pattern: "/p/post-:id", names: ["id"], join: ([a]) => `/p/post-${a}` },
    { pattern: "/x/:a-:b-:c", names: ["a", "b", "c"], join: ([a, b, c]) => `/x/${a}-${b}-${c}` },
    { pattern: "/f/:name:ext.txt", names: ["name", "ext"], join: ([a, b]) => `/f/${a}${b}.txt` },
    {
      pattern: "/x/:a:b:c.txt",
      names: ["a", "b", "c"],
      join: ([a, b, c]) => `/x/${a}${b}${c}.txt`,
    },
    { pattern: "/v:a:b.json", names: ["a", "b"], join: ([a, b]) => `/v${a}${b}.json` },
  ]
  const partners = ["x", "a.b", "-", "a-b", "é", "%2e"]
  const failures: string[] = []
  let built = 0
  let refused = 0
  for (const shape of shapes) {
    const compiled = compileRoutePattern(shape.pattern)
    for (const value of VALUES) {
      if (refusedAsSegment(value)) continue
      for (const partner of partners) {
        for (let at = 0; at < shape.names.length; at++) {
          const values = shape.names.map((_name, i) => (i === at ? value : partner))
          const params = Object.fromEntries(shape.names.map((name, i) => [name, values[i]!]))
          const path = filled(shape.pattern, params)
          const naive = shape.join(values.map((v) => encodePathSegment(v)))
          const read = matchRoutePattern(compiled, new URL(naive, ORIGIN).pathname)
          const same = read.matched && JSON.stringify(read.params) === JSON.stringify(params)
          if ((path !== undefined) !== same) {
            failures.push(
              `${shape.pattern} ${JSON.stringify(params)}: built ${path !== undefined}, read back ${same}`,
            )
          }
          if (path === undefined) refused++
          else built++
        }
      }
    }
  }
  expect(failures).toEqual([])
  // `.` and `..` are refused in every position, not only as a whole segment.
  expect(filled("/f/:name.:ext", { name: "..", ext: "x" })).toBeUndefined()
  expect(filled("/p/post-:id", { id: "." })).toBeUndefined()
  expect(built).toBeGreaterThan(1000)
  expect(refused).toBeGreaterThan(50)
})

test("adjacent mixed parameters only accept the router's one-character split", () => {
  for (const a of ["hello", "é", " ", "%", "😀"]) {
    expect(fillRoutePath("/:a:b.txt", { a, b: "world" })).toEqual({
      ok: false,
      missing: [],
      invalid: ["a"],
    })
  }
  expect(fillRoutePath("/:a:b:c.txt", { a: "hello", b: "world", c: "end" })).toEqual({
    ok: false,
    missing: [],
    invalid: ["a", "b"],
  })
  const params = { a: "h", b: "é world" }
  const compiled = compileRoutePattern("/:a:b.txt")
  const result = fillRoutePath(compiled, params)
  expect(result).toEqual({ ok: true, path: "/h%C3%A9%20world.txt" })
  if (result.ok) expect(matchRoutePattern(compiled, result.path)).toEqual({ matched: true, params })
})
