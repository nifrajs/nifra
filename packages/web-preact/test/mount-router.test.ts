import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Fetcher, RenderProps, RouterState } from "@nifrajs/web"
import { createClientRouter } from "@nifrajs/web/client"
import { GlobalWindow } from "happy-dom"
import { type ComponentChildren, h } from "preact"
import { hydrate, mountRouter } from "../src/client.ts"
import { setMountedRouter, useFetcher, useFetchers } from "../src/fetcher.ts"
import { preactAdapter } from "../src/index.ts"

const PATTERNS = [{ routeId: "page", pattern: "/" }]

/** A container holding the server's markup for `chain`, as the browser receives it. */
const serverRendered = async (chain: readonly unknown[], props: RenderProps) => {
  const container = document.createElement("div")
  container.innerHTML = (await preactAdapter.renderToString?.(chain, props)) ?? ""
  return container
}

const window = new GlobalWindow({ url: "http://shop.test/" })
const installed: string[] = []

beforeAll(() => {
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis) continue
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: Reflect.get(window, key),
    })
    installed.push(key)
  }
})

afterAll(async () => {
  for (const key of installed) Reflect.deleteProperty(globalThis, key)
  await window.happyDOM.close()
})

test("the mounted Router hands the page the server components it was rendered with", async () => {
  // The generated client entry seeds the router with the state the server rendered, and the docs have
  // a page pass `props.serverComponents` to its `ServerComponent` outlet: on the client it must be the
  // same state, or the outlet hydrates with nothing to resolve.
  const components: NonNullable<RouterState["serverComponents"]> = {
    v: 1,
    build: "build",
    adapter: "preact",
    owner: "owner",
    scope: "anonymous",
    records: [],
  }
  const seen: RenderProps["serverComponents"][] = []
  const Page = (props: RenderProps) => {
    seen.push(props.serverComponents)
    return h("p", null, "page")
  }
  const initial: RouterState = {
    routeId: "page",
    params: {},
    path: "/",
    data: null,
    serverComponents: components,
    pending: false,
  }
  const container = await serverRendered([Page], {
    data: null,
    serverComponents: components,
    params: {},
    path: "/",
    search: {},
  })
  expect(seen).toEqual([components])

  const router = createClientRouter({ patterns: PATTERNS, initial })
  mountRouter({ router, routes: { page: [Page] }, container })
  expect(seen.length).toBe(2)
  expect(seen[1]).toBe(components)
})

test("the mounted Router hands each layout its own data and keeps the server's markup", async () => {
  const layouts: unknown[] = []
  const Layout = (props: { data: unknown; children?: ComponentChildren }) => {
    layouts.push(props.data)
    return h("section", null, props.children)
  }
  const Page = (props: RenderProps) => h("p", null, JSON.stringify(props.data))
  const container = await serverRendered([Layout, Page], {
    data: { page: 1 },
    layoutData: [{ nav: "main" }],
    params: {},
    path: "/",
    search: {},
  })
  const markup = container.innerHTML
  const router = createClientRouter({
    patterns: PATTERNS,
    initial: {
      routeId: "page",
      params: {},
      path: "/",
      data: { page: 1 },
      layoutData: [{ nav: "main" }],
      pending: false,
    },
  })
  mountRouter({ router, routes: { page: [Layout, Page] }, container })
  expect(layouts).toEqual([{ nav: "main" }, { nav: "main" }])
  expect(container.innerHTML).toBe(markup)
})

test("hydrate renders a server-rendered chain with the props it is given", async () => {
  const seen: unknown[] = []
  const Page = (props: RenderProps) => {
    seen.push(props.data)
    return h("p", null, "page")
  }
  const props: RenderProps = { data: { id: 1 }, params: {}, path: "/", search: {} }
  const container = await serverRendered([Page], props)
  const markup = container.innerHTML
  hydrate([Page], props, container)
  expect(seen).toEqual([{ id: 1 }, { id: 1 }])
  expect(container.innerHTML).toBe(markup)
})

test("useFetcher and useFetchers read the mounted router's fetchers, and idle before a mount", async () => {
  const seen: { load: unknown; pending: boolean; fetchers: readonly Fetcher[] }[] = []
  const Page = () => {
    const fetcher = useFetcher("save")
    seen.push({ load: fetcher.load, pending: fetcher.pending, fetchers: useFetchers() })
    return h("p", null, "page")
  }
  setMountedRouter(undefined)
  const container = await serverRendered([Page], { data: null, params: {}, path: "/", search: {} })
  expect(seen).toEqual([{ load: expect.any(Function), pending: false, fetchers: [] }])

  const router = createClientRouter({
    patterns: PATTERNS,
    initial: { routeId: "page", params: {}, path: "/", data: null, pending: false },
  })
  mountRouter({ router, routes: { page: [Page] }, container })
  const mounted = seen.at(-1)
  expect(mounted?.load).toBe(router.fetcher("save").load)
  expect(mounted?.pending).toBe(false)
  expect(mounted?.fetchers).toContain(router.fetcher("save"))
})
