import { expect, test } from "bun:test"
import type { RenderProps } from "@nifrajs/web"
import {
  createRenderer,
  createSSRApp,
  defineComponent,
  h,
  nextTick,
  type RendererOptions,
  shallowRef,
} from "vue"
import { renderToString } from "vue/server-renderer"
import { compose } from "../src/compose.ts"
import { RenderPropsProvider, SearchProvider, useMatches, useSearch } from "../src/router.ts"

/** Shows what `useSearch` and `useMatches` read, so a test can see both providers' values. */
const Reader = defineComponent({
  setup() {
    const search = useSearch()
    const matches = useMatches()
    return () =>
      h("p", null, `${String(search.value.page)} ${matches.value.map((m) => m.pathname).join(",")}`)
  },
})

const propsAt = (org: string, page: number): RenderProps => ({
  data: null,
  params: { org },
  path: `/orgs/${org}?page=${page}`,
  search: { page },
  matchChain: { ids: ["orgs/[org]"], handles: [null] },
})

test("compose adds one component instance around the chain", async () => {
  // Each Vue component instance is a large share of a small page's SSR cost: a second provider
  // wrapper here cost about 13% of Vue SSR throughput. Root app + route context + page = 3.
  let instances = 0
  const app = createSSRApp({ render: () => compose([Reader], propsAt("acme", 1)) })
  app.mixin({
    beforeCreate() {
      instances++
    },
  })
  const html = await renderToString(app)
  expect(html).toContain("<p>1 /orgs/acme</p>")
  expect(instances).toBe(3)
})

interface TestNode {
  readonly tag: string
  text: string
  children: TestNode[]
  parent: TestNode | null
}

const node = (tag: string, text = ""): TestNode => ({ tag, text, children: [], parent: null })

const textOf = (n: TestNode): string =>
  n.tag === "#comment" ? "" : n.text + n.children.map(textOf).join("")

function detach(child: TestNode): void {
  const parent = child.parent
  if (parent === null) return
  parent.children.splice(parent.children.indexOf(child), 1)
  child.parent = null
}

// An in-memory host so the client render path (re-render on new props) runs without a DOM.
const memoryHost: RendererOptions<TestNode, TestNode> = {
  insert(child, parent, anchor) {
    detach(child)
    const at = anchor == null ? -1 : parent.children.indexOf(anchor)
    if (at === -1) parent.children.push(child)
    else parent.children.splice(at, 0, child)
    child.parent = parent
  },
  remove: detach,
  createElement: (tag) => node(tag),
  createText: (text) => node("#text", text),
  createComment: (text) => node("#comment", text),
  setText(n, text) {
    n.text = text
  },
  setElementText(el, text) {
    for (const child of [...el.children]) detach(child)
    el.text = text
  },
  parentNode: (n) => n.parent,
  nextSibling(n) {
    const siblings = n.parent?.children
    return siblings?.[siblings.indexOf(n) + 1] ?? null
  },
  patchProp() {},
}

test("a client re-render with new props updates useSearch and useMatches", async () => {
  const props = shallowRef(propsAt("acme", 1))
  const root = node("root")
  createRenderer(memoryHost)
    .createApp({ render: () => compose([Reader], props.value) })
    .mount(root)
  expect(textOf(root)).toBe("1 /orgs/acme")
  props.value = propsAt("beta", 2)
  await nextTick()
  expect(textOf(root)).toBe("2 /orgs/beta")
})

test("SearchProvider and RenderPropsProvider still provide on their own", async () => {
  const html = await renderToString(
    createSSRApp({
      render: () =>
        h(
          SearchProvider,
          { value: { page: 7 } },
          {
            default: () =>
              h(RenderPropsProvider, { value: propsAt("solo", 1) }, { default: () => h(Reader) }),
          },
        ),
    }),
  )
  expect(html).toContain("<p>7 /orgs/solo</p>")
})
