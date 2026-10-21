import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { GlobalWindow } from "happy-dom"
import { type App, createSSRApp, defineComponent, h, nextTick, ref, useId } from "vue"
import { renderToString } from "vue/server-renderer"
import { Hole, type HoleDefinition, type HoleProps } from "../src/ppr.ts"

// The client half of `Hole`, in a happy-dom document: what a browser runs once the PPR runtime has put
// a hole's server HTML into its host. The browser checks in @nifrajs/web cover the real runtime.
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
  Reflect.deleteProperty(globalThis, "__nifraPpr")
  for (const key of installed) Reflect.deleteProperty(globalThis, key)
  await window.happyDOM.close()
})

interface Fill {
  readonly props?: unknown
  readonly error: boolean
}

/** A stand-in for the shell's inline runtime: the fills it holds and who waits for one. */
function runtime(fills: Record<string, Fill> = {}) {
  const waiting = new Map<string, (fill: Fill) => void>()
  const unsubscribed: string[] = []
  const api = Object.assign(() => {}, {
    get: (name: string) => fills[name],
    subscribe(name: string, callback: (fill: Fill) => void) {
      waiting.set(name, callback)
      return () => {
        waiting.delete(name)
        unsubscribed.push(name)
      }
    },
  })
  Reflect.set(globalThis, "__nifraPpr", api)
  return { waiting, unsubscribed }
}

const Counter = defineComponent({
  props: { start: { type: Number, required: true } },
  setup(props) {
    const count = ref(props.start)
    const id = useId()
    return () =>
      h("button", { id, type: "button", onClick: () => count.value++ }, `cart ${count.value}`)
  },
})

type Cart = { readonly count: number }
const cart: HoleDefinition<Cart> = {
  name: "cart",
  interactive: true,
  render: (data) => h(Counter, { start: data.count }),
  fallback: h("p", null, "loading cart"),
}

/** The hole's HTML as the server renders it into its frame. */
async function served(of: HoleDefinition<Cart>, data: Cart): Promise<string> {
  const app = createSSRApp({ render: () => of.render(data) })
  app.config.idPrefix = `nifra-${of.name}-`
  return renderToString(app)
}

/**
 * The page as the shell left it, hydrated: the host holds the server's HTML for `data`, as the runtime
 * writes it before the page's own app hydrates. `tick` re-renders the page.
 */
async function hydratePage(of: HoleDefinition<Cart>, data?: Cart) {
  const tick = ref(0)
  const props: HoleProps<Cart> = { of, state: { status: "pending", ppr: true } }
  const Page = defineComponent(() => () => h("main", { "data-tick": tick.value }, [h(Hole, props)]))
  const container = document.createElement("div")
  container.innerHTML = await renderToString(createSSRApp(Page))
  document.body.append(container)
  const host = container.querySelector(`[data-nifra-hole="${of.name}"]`)
  if (host === null) throw new Error("the shell has no host")
  if (data !== undefined) host.innerHTML = await served(of, data)
  const page: App = createSSRApp(Page)
  page.mount(container)
  await nextTick()
  return { host, page, tick }
}

const click = async (host: Element) => {
  host.querySelector("button")?.click()
  await nextTick()
}

describe("Hole in the browser", () => {
  test("an interactive hole whose fill arrived first hydrates its server HTML as its own app", async () => {
    const fill = { props: { count: 2 }, error: false }
    runtime({ cart: fill })
    const { host, page, tick } = await hydratePage(cart, fill.props)
    const button = host.querySelector("button")
    expect(button?.id).toBe("nifra-cart--0")
    await click(host)
    expect(host.textContent).toBe("cart 3")
    expect(host.querySelector("button")).toBe(button)
    // The page rendering again leaves the host's children to the hole's own app.
    tick.value++
    await nextTick()
    expect(host.textContent).toBe("cart 3")
    page.unmount()
  })

  test("a hole that is still loading hydrates when its fill arrives, and stops waiting on unmount", async () => {
    const { waiting, unsubscribed } = runtime()
    const fill = { props: { count: 5 }, error: false }
    const { host, page } = await hydratePage(cart)
    const deliver = waiting.get("cart")
    expect(deliver).toBeDefined()
    host.innerHTML = await served(cart, fill.props)
    deliver?.(fill)
    await click(host)
    expect(host.textContent).toBe("cart 6")
    page.unmount()
    expect(unsubscribed).toEqual(["cart"])
    expect(host.childNodes.length).toBe(0)
  })

  test("a failed fill, a non-interactive hole and a page without the runtime hydrate nothing", async () => {
    const failed = runtime({ cart: { error: true } })
    const broken = await hydratePage(cart)
    expect(broken.host.innerHTML).toBe("")
    expect(failed.waiting.size).toBe(0)
    broken.page.unmount()

    const fill = { props: { count: 1 }, error: false }
    runtime({ cart: fill })
    const inert = await hydratePage({ ...cart, interactive: false }, fill.props)
    await click(inert.host)
    expect(inert.host.textContent).toBe("cart 1")
    inert.page.unmount()

    Reflect.deleteProperty(globalThis, "__nifraPpr")
    const bare = await hydratePage(cart, fill.props)
    await click(bare.host)
    expect(bare.host.textContent).toBe("cart 1")
    bare.page.unmount()
  })

  test("after a client navigation, a hole whose deferred data resolves renders it", async () => {
    // Both states are a `<p>`, so Vue patches the node in place (see the rejection case below).
    const note: HoleDefinition<{ readonly text: string }> = {
      name: "note",
      render: (data) => h("p", null, data.text),
      fallback: h("p", null, "loading note"),
    }
    const { promise, resolve } = Promise.withResolvers<{ readonly text: string }>()
    const Page = defineComponent(
      () => () =>
        h(Hole, {
          of: note,
          state: { status: "pending", data: { __nifra_deferred: true, promise } },
        }),
    )
    const container = document.createElement("main")
    container.innerHTML = await renderToString(createSSRApp(Page))
    document.body.append(container)
    expect(container.textContent).toBe("loading note")
    const app = createSSRApp(Page)
    app.mount(container)
    resolve({ text: "two notes" })
    await promise
    await nextTick()
    expect(container.textContent).toBe("two notes")
    app.unmount()
  })

  test("after a client navigation, a hole whose deferred data rejects shows its error", async () => {
    const failure = Promise.reject(new Error("cart service down"))
    failure.catch(() => {})
    const Page = defineComponent(
      () => () =>
        h(
          Hole,
          {
            of: cart,
            state: { status: "pending", data: { __nifra_deferred: true, promise: failure } },
          },
          { error: () => h("p", { id: "cart-error" }, "cart unavailable") },
        ),
    )
    const container = document.createElement("main")
    container.innerHTML = await renderToString(createSSRApp(Page))
    document.body.append(container)
    expect(container.textContent).toBe("loading cart")
    // Hydrated, and the error is a `<p>` like the fallback, so Vue patches the node in place: the
    // suite's Vue may have loaded before this file installed a DOM, and runtime-dom keeps the
    // `document` it saw then, so it cannot create nodes here.
    const app = createSSRApp(Page)
    app.mount(container)
    await failure.catch(() => {})
    await nextTick()
    expect(container.querySelector("#cart-error")?.textContent).toBe("cart unavailable")
    app.unmount()
  })
})
