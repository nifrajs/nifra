import { expect, test } from "bun:test"
import type { RenderProps, RouterState } from "@nifrajs/web"
import type { SlotNode } from "@nifrajs/web/keep-alive"
import { type Accessor, createComponent, createRoot, type JSX } from "solid-js"
import { renderToString } from "solid-js/web"
import { solidAdapter } from "../src/index.ts"
import { documentTree, KeepAliveView } from "../src/keep-alive-view.ts"
import { onPageHide, onPageShow, PageContext, usePageVisibility } from "../src/page-visibility.ts"
import { useSearch } from "../src/router.ts"

// The keep-alive view rendered in process, by Solid's server build; the browser suite hides and shows
// kept pages.
type ChainProps = { data: unknown; boundaries?: unknown; children?: JSX.Element }
const layout =
  (name: string) =>
  (props: ChainProps): JSX.Element => [
    `${name}:${String(props.data)}:${typeof props.boundaries}`,
    props.children,
  ]
const Boundary = (props: ChainProps): JSX.Element => [
  `boundary:${String(props.data)}:${typeof props.boundaries}`,
  props.children,
]
const Page = (props: { data: unknown }): JSX.Element => {
  const visible = usePageVisibility()
  const search = useSearch()
  onPageHide(() => {})
  return `page:${String(props.data)}:${String(visible())}:${String(search().q)}`
}
// The markup without Solid's hydration comments, in one scan: a regex pass can leave a comment opener
// that two overlapping ones form.
const textOf = (html: string): string => {
  let text = ""
  let at = 0
  for (let open = html.indexOf("<!--"); open >= 0; open = html.indexOf("<!--", at)) {
    text += html.slice(at, open)
    const close = html.indexOf("-->", open + 4)
    at = close < 0 ? html.length : close + 3
  }
  return text + html.slice(at)
}
const count = (html: string, attribute: string): number =>
  html.match(new RegExp(attribute, "g"))?.length ?? 0

test("a keep-alive app's document renders the page inside the slot wrappers its route keeps", async () => {
  const props: RenderProps = {
    data: "d",
    layoutData: ["l", "m"],
    path: "/p",
    params: {},
    search: { q: "s" },
  }
  const html =
    (await solidAdapter.renderToString?.([layout("outer"), Page], props, { slots: [1] })) ?? ""
  expect(textOf(html)).toContain("outer:l:undefined")
  expect(textOf(html)).toContain("page:d:true:s")
  expect([count(html, "data-nifra-entry"), count(html, "data-nifra-page")]).toEqual([1, 1])
  expect(html).toMatch(/<slot [^>]*data-nifra-entry[^>]*><slot [^>]*data-nifra-page/)
  expect(html).not.toContain("style=")

  const chain = [layout("outer"), layout("inner"), Page]
  const streamed = await new Response(
    await solidAdapter.renderToStream(chain, props, { slots: [0] }),
  ).text()
  expect(textOf(streamed)).toContain("inner:m:undefined")
  expect(count(streamed, "data-nifra-entry")).toBe(1)
})

test("the document's tree is one path of slots, wrapped where the app keeps them", () => {
  const state: RouterState = { routeId: "r", params: {}, path: "/p", data: null, pending: false }
  const path = (node: SlotNode | undefined): string[] =>
    node === undefined ? [] : [`${node.key.slice(1)}:${node.wrapped}`, ...path(node.children?.[0])]
  const chain = [layout("outer"), layout("inner"), Page]
  expect(path(documentTree(chain, state, [2])[0])).toEqual([
    "layout0:false",
    "layout1:false",
    "page:true",
  ])
  expect(documentTree([layout("outer"), Page], state, [0])).toEqual([
    {
      key: "\0layout0",
      depth: 0,
      state,
      hidden: false,
      wrapped: true,
      children: [{ key: "\0page", depth: 1, state, hidden: false, wrapped: false }],
    },
  ])
})

test("each slot renders its own state, and a page's `_error` boundary renders inside its slot", () => {
  const stateAt = (path: string): RouterState => ({
    routeId: "r",
    params: {},
    path,
    data: path,
    pending: false,
  })
  const propsOf = (of: Accessor<RouterState>): RenderProps => ({
    get data() {
      return of().data
    },
    get path() {
      return of().path
    },
    params: {},
    get search() {
      return { q: of().path }
    },
    layoutData: ["l"],
  })
  const pageAt = (key: string, path: string, hidden: boolean): SlotNode => ({
    key,
    depth: 1,
    state: stateAt(path),
    hidden,
    wrapped: true,
  })
  const tree: readonly SlotNode[] = [
    {
      key: "\0layout0",
      depth: 0,
      state: stateAt("/b"),
      hidden: false,
      wrapped: false,
      children: [pageAt("\x001", "/a", true), pageAt("\x002", "/b", false)],
    },
  ]
  const html = renderToString(() =>
    KeepAliveView({
      tree: () => tree,
      shown: propsOf(() => stateAt("/b")),
      mount: {
        propsOf,
        // The browser's chain of an error route: the layouts, the `_error` boundary, then the page.
        chainOf: () => [layout("outer"), Boundary, Page],
        entry: () => undefined,
        page: () => undefined,
      },
    }),
  )
  const text = textOf(html)
  expect(text).toContain("outer:l:undefined")
  expect(count(text, "boundary:null:undefined")).toBe(2)
  expect(text).toContain("page:/a:false:/a")
  expect(text).toContain("page:/b:true:/b")
  expect(count(html, "data-nifra-page")).toBe(2)
})

test("a kept page's visibility and callbacks come from its slot, and nothing outside one", () => {
  let hidden = true
  const slot = { hidden: () => hidden, hide: new Set<() => void>(), show: new Set<() => void>() }
  const seen: boolean[] = []
  const dispose = createRoot((dispose) => {
    renderToString(() =>
      createComponent(PageContext.Provider, {
        value: slot,
        get children() {
          const visible = usePageVisibility()
          seen.push(visible())
          hidden = false
          seen.push(visible())
          onPageHide(() => {})
          onPageShow(() => {})
          return ""
        },
      }),
    )
    return dispose
  })
  expect(seen).toEqual([false, true])
  expect([slot.hide.size, slot.show.size]).toEqual([1, 1])
  dispose()

  createRoot((dispose) => {
    expect(usePageVisibility()()).toBe(true)
    onPageHide(() => {})
    onPageShow(() => {})
    dispose()
  })
})
