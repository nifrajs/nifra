import { expect, test } from "bun:test"
import {
  type ComponentInternalInstance,
  createSSRApp,
  defineAsyncComponent,
  defineComponent,
  getCurrentInstance,
  h,
  type Slots,
} from "vue"
import { renderToString } from "vue/server-renderer"
import { compose } from "../src/compose.ts"
import { errorBoundary } from "../src/error.ts"
import { EVERY_ROUTE_PROP, ROUTE_PROP_NAMES } from "./fixtures/route-props.ts"

// A route prop a component does not declare reaches Vue as an attribute, which it puts on the
// component's root element: the client renders an object as "[object Object]" and the server renders
// it not at all, and a fragment root warns on every render instead.

let rendered: ComponentInternalInstance | null = null
const root = (slots: Slots) => {
  rendered = getCurrentInstance()
  return h("div", { id: "root" }, slots.default?.())
}
const kebab = (name: string): string => name.replace(/\B([A-Z])/g, "-$1").toLowerCase()

// Every way a Vue component declares the props it takes.
const declaring: Readonly<Record<string, (names: string[]) => unknown>> = {
  "a props array": (names) =>
    defineComponent({
      props: names,
      setup:
        (_props, { slots }) =>
        () =>
          root(slots),
    }),
  "a props object": (names) =>
    defineComponent({
      props: Object.fromEntries(names.map((name) => [name, null])),
      setup:
        (_props, { slots }) =>
        () =>
          root(slots),
    }),
  "kebab-case props": (names) =>
    defineComponent({
      props: names.map(kebab),
      setup:
        (_props, { slots }) =>
        () =>
          root(slots),
    }),
  "props it extends": (names) =>
    defineComponent({
      extends: { props: names },
      setup:
        (_props, { slots }) =>
        () =>
          root(slots),
    }),
  "props from a mixin": (names) =>
    defineComponent({
      mixins: [{ props: names }],
      setup:
        (_props, { slots }) =>
        () =>
          root(slots),
    }),
  "a functional component with props": (names) =>
    Object.assign((_props: object, { slots }: { slots: Slots }) => root(slots), { props: names }),
  "a class component": (names) =>
    Object.assign(class Page {}, {
      __vccOpts: defineComponent({
        props: names,
        setup:
          (_props, { slots }) =>
          () =>
            root(slots),
      }),
    }),
}

const Leaf = defineComponent({ props: ["data"], setup: () => () => h("p", null, "page") })

const render = async (chain: readonly unknown[]) => {
  rendered = null
  const warnings: string[] = []
  const app = createSSRApp({ render: () => compose(chain, EVERY_ROUTE_PROP) })
  app.config.warnHandler = (message) => {
    warnings.push(message)
  }
  await renderToString(app)
  if (rendered === null) throw new Error("[test] the component under test did not render")
  const instance: ComponentInternalInstance = rendered
  return {
    // The props Vue put on the component's root element, beside its own `id`.
    root: Object.keys(instance.subTree.props ?? {}).filter((key) => key !== "id"),
    props: { ...instance.props },
    warnings,
  }
}

for (const [kind, make] of Object.entries(declaring)) {
  test(`a page with ${kind} gets each route prop it declares and puts none on its root`, async () => {
    for (const name of ROUTE_PROP_NAMES) {
      const seen = await render([make([name])])
      expect({ name, ...seen }).toEqual({
        name,
        root: [],
        props: { [name]: Reflect.get(EVERY_ROUTE_PROP, name) },
        warnings: [],
      })
    }
  })

  test(`a layout with ${kind} gets each route prop it declares and puts none on its root`, async () => {
    // A layout's own loader data arrives as its `data`.
    const layoutProps = {
      data: EVERY_ROUTE_PROP.layoutData[0],
      boundaries: EVERY_ROUTE_PROP.boundaries,
    }
    for (const name of ROUTE_PROP_NAMES) {
      const seen = await render([make([name]), Leaf])
      expect({ name, ...seen }).toEqual({
        name,
        root: [],
        props: { [name]: Reflect.get(layoutProps, name) },
        warnings: [],
      })
    }
  })
}

test("a functional page that declares no props gets every route prop and puts none on its root", async () => {
  // Vue hands such a component every prop, and puts only `class`, `style` and listeners on its root.
  const seen = await render([(_props: object, { slots }: { slots: Slots }) => root(slots)])
  expect(seen).toEqual({ root: [], props: { ...EVERY_ROUTE_PROP }, warnings: [] })
})

test("a page whose options a hot reload rewrote gets the props it declares now", async () => {
  const Page = defineComponent({
    props: ["data"],
    setup:
      (_props, { slots }) =>
      () =>
        root(slots),
  })
  expect((await render([Page])).props).toEqual({ data: EVERY_ROUTE_PROP.data })
  // What Vue's hot reload does to the component a route module exported.
  Object.assign(Page, { props: ["data", "pending"] })
  expect((await render([Page])).props).toEqual({ data: EVERY_ROUTE_PROP.data, pending: true })
})

test("an async page gets each route prop it declares", async () => {
  // The wrapper passes every prop to the component it loads, which is unknown until it has loaded.
  for (const name of ROUTE_PROP_NAMES) {
    const Page = defineAsyncComponent(async () =>
      defineComponent({
        props: [name],
        setup:
          (_props, { slots }) =>
          () =>
            root(slots),
      }),
    )
    const { props } = await render([Page])
    expect({ name, props }).toEqual({
      name,
      props: { [name]: Reflect.get(EVERY_ROUTE_PROP, name) },
    })
  }
})

test("a page with a fragment root that declares only data renders with no warning", async () => {
  const warnings: string[] = []
  const Page = defineComponent({
    props: ["data"],
    setup: () => () => [h("p", null, "one"), h("p", null, "two")],
  })
  const app = createSSRApp({ render: () => compose([Page], EVERY_ROUTE_PROP) })
  app.config.warnHandler = (message) => {
    warnings.push(message)
  }
  expect(await renderToString(app)).toBe("<!--[--><!--[--><p>one</p><p>two</p><!--]--><!--]-->")
  expect(warnings).toEqual([])
})

test("the _error boundary between the layouts and the page renders with no warning", async () => {
  // It declares no props and renders its slot as a fragment.
  const warnings: string[] = []
  const Layout = defineComponent({
    props: ["data"],
    setup:
      (_props, { slots }) =>
      () =>
        h("main", null, slots.default?.()),
  })
  const app = createSSRApp({
    render: () => compose([Layout, errorBoundary(Leaf), Leaf], EVERY_ROUTE_PROP),
  })
  app.config.warnHandler = (message) => {
    warnings.push(message)
  }
  expect(await renderToString(app)).toBe("<!--[--><main><!--[--><p>page</p><!--]--></main><!--]-->")
  expect(warnings).toEqual([])
})
