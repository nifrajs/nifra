import { expect, test } from "bun:test"
import type { MatchChain, RouterState } from "@nifrajs/web"
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
  expect(props.layoutData).toEqual([{ user: "ada" }])
  expect(props.actionData).toEqual({ saved: true })
  expect(props.pending).toBe(false)
  expect(props.params).toEqual({ id: "7" })
  expect(props.path).toBe("/items/7?sort=asc")
  expect(props.submission).toBeUndefined()
  expect(props.boundaries).toEqual({})
  expect(props.matchChain).toBe(chain)
  expect(props.search).toEqual({ sort: "asc" })

  state = { ...first, pending: true, path: "/items/8" }
  expect(props.pending).toBe(true)
  expect(props.path).toBe("/items/8")
  expect(props.search).toEqual({})
})
