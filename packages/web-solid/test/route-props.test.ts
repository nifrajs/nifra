import { expect, test } from "bun:test"
import type { MatchChain, RouterState } from "@nifrajs/web"
import { routeProps as snapshotProps } from "@nifrajs/web/internal/route-props-runtime"
import { routeProps } from "../src/route-props.ts"

test("route props read every field from the latest snapshot", () => {
  const first: RouterState = {
    routeId: "items",
    data: { items: 1 },
    layoutData: [{ user: "ada" }],
    actionData: { saved: true },
    pending: false,
    params: { id: "7" },
    path: "/items/7?sort=asc",
    boundaries: {},
  }
  let state = first
  const chain: MatchChain = { ids: ["_layout", "items"], handles: [undefined, { crumb: "Items" }] }
  const props = routeProps(() => state, undefined, { items: chain })
  expect(props.data).toEqual({ items: 1 })
  expect(props.serverComponents).toBeUndefined()
  expect(props.layoutData).toEqual([{ user: "ada" }])
  expect(props.actionData).toEqual({ saved: true })
  expect(props.pending).toBe(false)
  expect(props.params).toEqual({ id: "7" })
  expect(props.path).toBe("/items/7?sort=asc")
  expect(props.submission).toBeUndefined()
  expect(props.boundaries).toEqual({})
  expect(props.matchChain).toBe(chain)
  expect(props.search).toEqual({ sort: "asc" })

  const components = {
    v: 1 as const,
    build: "build",
    adapter: "solid" as const,
    owner: "owner",
    scope: "anonymous",
    records: [],
  }
  state = { ...first, pending: true, path: "/items/8", serverComponents: components }
  expect(props.serverComponents).toBe(components)
  expect(props.pending).toBe(true)
  expect(props.path).toBe("/items/8")
  expect(props.search).toEqual({})
})

test("route props hand the page what every other adapter's mount does", () => {
  // Solid reads each field through a getter; the other adapters build one object with the shared
  // builder. A field one of them gains and the other lacks renders differently after hydration.
  const chain: MatchChain = { ids: ["items"], handles: [undefined] }
  const full: RouterState = {
    serverComponents: {
      v: 1,
      build: "build",
      adapter: "solid",
      owner: "owner",
      scope: "anonymous",
      records: [],
    },
    routeId: "items",
    params: { id: "7" },
    path: "/photos/3",
    data: { item: 7 },
    layoutData: [{ nav: "main" }],
    boundaries: { modal: { name: "modal", mode: { intercept: "items" }, status: "ready" } },
    actionData: { saved: true },
    pending: true,
    pendingPath: "/items/8",
    submission: { action: "/items/7", formData: new FormData() },
    intercepted: { boundary: "modal", pagePath: "/items/7?sort=asc" },
  }
  const bare: RouterState = {
    routeId: "items",
    params: {},
    path: "/items",
    data: null,
    pending: false,
  }
  for (const state of [full, bare]) {
    const shared = snapshotProps(state, undefined, { items: chain })
    const props = routeProps(() => state, undefined, { items: chain })
    for (const key of new Set([...Object.keys(shared), ...Object.keys(props)]))
      expect([key, Reflect.get(props, key)]).toEqual([key, Reflect.get(shared, key)])
  }
})
