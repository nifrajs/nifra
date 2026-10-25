import { expect, test } from "bun:test"
import { routeProps } from "../src/internal/route-props-runtime.ts"
import type { MatchChain, RenderProps } from "../src/render-seam.ts"
import type { RouterState } from "../src/router.ts"

// Where a client render finds each `RenderProps` field. A field added to the protocol fails the
// typecheck here until it is placed, so the client cannot silently render a page without it.
const SOURCE = {
  data: "state",
  serverComponents: "state",
  layoutData: "state",
  actionData: "state",
  pending: "state",
  submission: "state",
  boundaries: "state",
  params: "state",
  path: "derived",
  search: "derived",
  matchChain: "derived",
  // Read only by React's `useNavigation` and `NavLink`; the React adapter adds it.
  pendingPath: "adapter",
  // Set by the server render; the client names it from `path`.
  locale: "server",
} as const satisfies Record<keyof RenderProps, "state" | "derived" | "adapter" | "server">

const fromState = Object.entries(SOURCE).flatMap(([key, source]) =>
  source === "state" ? [key] : [],
)

const chain: MatchChain = {
  ids: ["_layout", "items/[id]"],
  handles: [undefined, { crumb: "Item" }],
}

// Every field set, each to a value of its own, so a copy from the wrong field cannot pass.
const full = {
  serverComponents: {
    v: 1,
    build: "build",
    adapter: "preact",
    owner: "owner",
    scope: "anonymous",
    records: [],
  },
  routeId: "items/[id]",
  params: { id: "7" },
  path: "/photos/3",
  data: { item: 7 },
  layoutData: [{ nav: "main" }],
  boundaries: { modal: { name: "modal", mode: { intercept: "items/[id]" }, status: "ready" } },
  actionData: { saved: true },
  pending: true,
  pendingPath: "/items/8",
  submission: { action: "/items/7", formData: new FormData() },
  intercepted: { boundary: "modal", pagePath: "/items/7?sort=asc" },
  live: { seed: 1 },
  instance: "items/7",
  kept: [],
  restored: false,
  revalidating: false,
} satisfies Required<RouterState>

const bare: RouterState = {
  routeId: "items/[id]",
  params: {},
  path: "/items/7",
  data: null,
  pending: false,
}

test("a snapshot's own fields reach the props unchanged", () => {
  const props = routeProps(full, undefined, { "items/[id]": chain })
  for (const key of fromState) {
    expect(Object.hasOwn(full, key)).toBe(true)
    expect(Reflect.get(props, key)).toBe(Reflect.get(full, key))
  }
})

test("fields the snapshot leaves out are undefined on the props", () => {
  const props = routeProps(bare, undefined)
  for (const key of fromState)
    if (Reflect.get(bare, key) === undefined)
      expect([key, Reflect.get(props, key)]).toEqual([key, undefined])
  // Left off, not set to `undefined`: a layout reads a missing entry as `null`.
  expect(Object.hasOwn(props, "layoutData")).toBe(false)
  expect(Object.hasOwn(props, "matchChain")).toBe(false)
})

test("path and search describe the page under an intercept boundary", () => {
  const props = routeProps(full, undefined, { "items/[id]": chain })
  expect(props.path).toBe("/items/7?sort=asc")
  expect(props.search).toEqual({ sort: "asc" })
  expect(props.matchChain).toBe(chain)
})

test("only the adapter or the server sets the rest", () => {
  const props = routeProps(full, undefined, { "items/[id]": chain })
  for (const [key, source] of Object.entries(SOURCE))
    if (source === "adapter" || source === "server") expect(Object.hasOwn(props, key)).toBe(false)
})

test("search stays the same object while the query is the same", () => {
  // A new object with equal content would count as a changed prop for a memoized page.
  const searchAt = (path: string) => routeProps({ ...bare, path }, undefined).search
  const first = searchAt("/items/7?page=2")
  expect(first).toEqual({ page: 2 })
  expect(searchAt("/items/7?page=2")).toBe(first)
  expect(searchAt("/items/7?page=3")).toEqual({ page: 3 })
})
