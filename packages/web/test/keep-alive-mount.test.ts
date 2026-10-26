import { describe, expect, test } from "bun:test"
import {
  additionsFor,
  keptMount,
  propsByState,
  SLOT_ROOT,
  type SlotAdditions,
  slotChildren,
} from "../src/internal/keep-alive-mount.ts"
import { type SlotNode, slotTree } from "../src/keep-alive.ts"
import type { MatchChain, RenderProps } from "../src/render-seam.ts"
import type { RouterState } from "../src/router.ts"

const state = (routeId: string, path: string, extra: Partial<RouterState> = {}): RouterState => ({
  routeId,
  path,
  params: {},
  data: { path },
  pending: false,
  ...extra,
})
const chain = (...ids: string[]): MatchChain => ({ ids, handles: ids.map(() => undefined) })
const CHAINS: Record<string, MatchChain> = {
  list: chain("_layout", "list"),
  detail: chain("_layout", "detail"),
  item: chain("_layout", "shop/_layout", "item"),
}
const TABLE = { routes: ["list", "item"], layouts: ["shop/_layout"] }
const ACTIVE = {
  ...state("detail", "/detail"),
  instance: "3:d",
  kept: [
    { instance: "2:d", state: state("item", "/shop/b") },
    { instance: "1:d", state: state("list", "/list/1") },
  ],
}

describe("keptMount", () => {
  const Layout = (): null => null
  const Page = (): null => null
  const mounted = () => {
    const listeners: ((next: RouterState) => void)[] = []
    const mount = keptMount({
      router: {
        beforePublish: (listener) => {
          listeners.push(listener)
          return () => {}
        },
      },
      routes: { detail: [Layout, Page] },
      matchChains: CHAINS,
      keepAlive: TABLE,
    })
    return { mount, listeners }
  }

  test("builds each state's tree as slotTree does, keeping the nodes that did not change", () => {
    const { mount } = mounted()
    const tree = mount.tree(ACTIVE, undefined)
    expect(tree).toEqual(slotTree(ACTIVE, CHAINS, TABLE))
    expect(mount.tree(ACTIVE, tree)[0]).toBe(tree[0])
  })

  test("reads a route's chain from the routes table, an unknown route's as empty", () => {
    const { mount } = mounted()
    expect(mount.chainOf(ACTIVE)).toEqual([Layout, Page])
    expect(mount.chainOf(state("unknown", "/x"))).toEqual([])
  })

  test("parks before each publish, from the tree the view last committed", () => {
    const { mount, listeners } = mounted()
    expect(listeners).toHaveLength(1)
    const tree = mount.tree(ACTIVE, undefined)
    mount.after(tree)
    expect(() => listeners[0]?.(state("list", "/list/1", { instance: "4:d" }))).not.toThrow()
    expect(mount.entry("\u00001:d")).toBe(mount.entry("\u00001:d"))
    expect(mount.page("\u00001:d")).toBe(mount.page("\u00001:d"))
  })
})

describe("propsByState", () => {
  test("builds a state's props once, and another state's apart", () => {
    const built: RouterState[] = []
    const propsOf = propsByState((of): RenderProps => {
      built.push(of)
      return { params: of.params, data: of.data, path: of.path, search: {} }
    })
    const first = state("list", "/list/1")
    const second = state("list", "/list/2")
    expect(propsOf(first)).toBe(propsOf(first))
    expect(propsOf(second)).not.toBe(propsOf(first))
    expect(built).toEqual([first, second])
  })
})

describe("slotChildren", () => {
  test("files the top level under SLOT_ROOT and each layout's slots under its key", () => {
    const tree = slotTree(ACTIVE, CHAINS, TABLE)
    const children = slotChildren(tree)
    const keys = (nodes: readonly SlotNode[] | undefined) => nodes?.map((node) => node.key)
    expect([...children.keys()]).toEqual([SLOT_ROOT, "_layout", "shop/_layout"])
    expect(keys(children.get(SLOT_ROOT))).toEqual(["_layout"])
    expect(keys(children.get("_layout"))).toEqual(["\u00001:d", "shop/_layout", "\u00003:d"])
    expect(keys(children.get("shop/_layout"))).toEqual(["\u00002:d"])
  })
})

describe("additionsFor", () => {
  const node = (key: string, hidden: boolean): SlotNode => ({
    key,
    depth: 1,
    state: state("list", "/list/1"),
    hidden,
    wrapped: true,
  })

  test("a shown slot takes what the layout passes; a hidden one keeps what it last had", () => {
    const held = new Map<string, SlotAdditions>()
    const a = { tone: "light" }
    const b = { tone: "dark" }
    expect(additionsFor(held, [node("x", false)], a)(node("x", false))).toBe(a)
    expect(additionsFor(held, [node("x", true)], b)(node("x", true))).toBe(a)
    expect(additionsFor(held, [node("x", false)], b)(node("x", false))).toBe(b)
  })

  test("equal additions keep the held object, and a slot that left is forgotten", () => {
    const held = new Map<string, SlotAdditions>()
    const a = { tone: "light" }
    additionsFor(held, [node("x", false), node("y", false)], a)(node("x", false))
    expect(additionsFor(held, [node("x", false)], { tone: "light" })(node("x", false))).toBe(a)
    expect(
      additionsFor(held, [node("x", false)], { tone: "light", size: 1 })(node("x", false)),
    ).toEqual({
      tone: "light",
      size: 1,
    })
    expect(additionsFor(held, [node("x", false)], undefined)(node("x", false))).toBeUndefined()
    expect([...held.keys()]).toEqual(["x"])
  })
})
