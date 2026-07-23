import { expect, test } from "bun:test"
import { buildManifest, filePathToRoutes, type Manifest } from "../src/manifest.ts"

const build = (files: string[]): Manifest =>
  buildManifest(files, () => async () => ({ default: "x" }))

const scopes = (files: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const route of build(files).routes) {
    out[route.pattern] = Object.fromEntries(
      route.layoutIds.map((id, i) => [id, route.layoutParams?.[i] ?? []]),
    )
  }
  return out
}

test("a layout owns the params in the URL prefix it wraps", () => {
  // The whole scoping mechanism: a layout at `orgs/[org]/` wraps `/orgs/:org`, so it owns `{org}` and
  // nothing deeper. That is both what it may read and what should re-run its loader.
  expect(scopes(["_layout.tsx", "orgs/[org]/_layout.tsx", "orgs/[org]/projects/[id].tsx"])).toEqual(
    {
      "/orgs/:org/projects/:id": { _layout: [], "orgs/[org]/_layout": ["org"] },
    },
  )
})

test("a route group contributes no segment, so its layout owns nothing", () => {
  expect(scopes(["(marketing)/_layout.tsx", "(marketing)/about.tsx"])).toEqual({
    "/about": { "(marketing)/_layout": [] },
  })
})

test("one layout can own different params on different expanded patterns", () => {
  // The case that makes scope a property of the (route, layout) PAIR rather than of the layout.
  // `[[lang]]` expands one file into two patterns, and the layout's prefix differs between them —
  // keying by layout id alone would be wrong for one of the two.
  expect(scopes(["[[lang]]/docs/_layout.tsx", "[[lang]]/docs/[slug].tsx"])).toEqual({
    "/docs/:slug": { "[[lang]]/docs/_layout": [] },
    "/:lang/docs/:slug": { "[[lang]]/docs/_layout": ["lang"] },
  })
})

test("a layout never owns a param from a route beneath it", () => {
  // Two routes under the same layout: the layout's scope must not widen to whichever route it wraps,
  // or a deeper param would invalidate a loader that cannot even read it.
  const s = scopes([
    "shops/[shop]/_layout.tsx",
    "shops/[shop]/index.tsx",
    "shops/[shop]/items/[item].tsx",
  ])
  expect(s["/shops/:shop"]).toEqual({ "shops/[shop]/_layout": ["shop"] })
  expect(s["/shops/:shop/items/:item"]).toEqual({ "shops/[shop]/_layout": ["shop"] })
})

test("scopes cover mixed and catch-all segments", () => {
  expect(scopes(["v[major].[minor]/_layout.tsx", "v[major].[minor]/x.tsx"])).toEqual({
    "/v:major.:minor/x": { "v[major].[minor]/_layout": ["major", "minor"] },
  })
  expect(scopes(["files/_layout.tsx", "files/[...rest].tsx"])).toEqual({
    "/files/*rest": { "files/_layout": [] },
  })
})

test("layoutParams is index-aligned with layoutIds", () => {
  // The invariant the render path depends on. A misalignment renders one layout's data in another,
  // which reads as a data bug long before it reads as a router bug.
  for (const route of build([
    "_layout.tsx",
    "a/_layout.tsx",
    "a/[x]/_layout.tsx",
    "a/[x]/b/[y].tsx",
  ]).routes) {
    expect(route.layoutParams).toHaveLength(route.layoutIds.length)
    expect(route.layoutIds).toEqual(["_layout", "a/_layout", "a/[x]/_layout"])
    expect(route.layoutParams).toEqual([[], [], ["x"]])
  }
})

test("depths stay aligned with the file's path parts", () => {
  // `depths[k]` is the URL-segment count after the first k path parts, including parts that emit
  // nothing — otherwise a group or an `index` would shift every layout's scope by one.
  expect(filePathToRoutes("(marketing)/about.tsx")).toEqual([
    { pattern: "/about", depths: [0, 0, 1] },
  ])
  expect(filePathToRoutes("index.tsx")).toEqual([{ pattern: "/", depths: [0, 0] }])
})
