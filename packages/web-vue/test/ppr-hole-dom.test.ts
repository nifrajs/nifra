import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { GlobalWindow } from "happy-dom"
import { type App, createSSRApp, defineComponent, h, nextTick, ref, shallowRef, useId } from "vue"
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

/** A data request's fill: the frame's JSON. */
interface Frame {
  readonly html: string
  readonly props?: unknown
  readonly error?: true
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
    put(name: string, frame: Frame, host: Element) {
      host.innerHTML = frame.html
      if (frame.error === true) host.setAttribute("data-nifra-hole-error", "")
      else host.removeAttribute("data-nifra-hole-error")
      fills[name] = { props: frame.props, error: frame.error === true }
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

/** Shows the props it was given beside a click count only the component holds. */
const Tally = defineComponent({
  props: { count: { type: Number, required: true } },
  setup(props) {
    const clicks = ref(0)
    return () =>
      h(
        "button",
        { type: "button", onClick: () => clicks.value++ },
        `cart ${props.count} clicked ${clicks.value}`,
      )
  },
})

/** A deferred fill, settled by the test as the NDJSON stream would. */
function deferredFill() {
  let resolve: (frame: Frame) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<Frame>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  promise.catch(() => {})
  return { fill: { __nifra_deferred: true, id: 0, promise }, resolve, reject, promise }
}

/** Lets a settled fill's promise reactions, and the renders they start, run. */
const settle = async (promise: Promise<unknown>) => {
  await promise.catch(() => {})
  await nextTick()
  await nextTick()
}

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
  const state = shallowRef<HoleProps<Cart>["state"]>({ status: "pending", ppr: true })
  const Page = defineComponent(
    () => () => h("main", { "data-tick": tick.value }, [h(Hole, { of, state: state.value })]),
  )
  const container = document.createElement("div")
  container.innerHTML = await renderToString(createSSRApp(Page))
  document.body.append(container)
  const host = container.querySelector(`[data-nifra-hole="${of.name}"]`)
  if (host === null) throw new Error("the shell has no host")
  if (data !== undefined) host.innerHTML = await served(of, data)
  const page: App = createSSRApp(Page)
  page.mount(container)
  await nextTick()
  /** The page rendered again with a reloaded state for its hole, as the router publishes it. */
  const reload = async (fill: unknown) => {
    state.value = { status: "pending", ppr: true, fill }
    await nextTick()
  }
  return { host, page, tick, reload }
}

const tally: HoleDefinition<Cart> = {
  name: "cart",
  interactive: true,
  render: (data) => h(Tally, { count: data.count }),
}

const click = async (host: Element) => {
  host.querySelector("button")?.click()
  await nextTick()
}

describe("Hole in the browser", () => {
  test("a refill re-renders an interactive app with new props and keeps its state; an older one is dropped", async () => {
    runtime({ cart: { props: { count: 2 }, error: false } })
    const { host, page, reload } = await hydratePage(tally, { count: 2 })
    await click(host)
    expect(host.textContent).toBe("cart 2 clicked 1")
    const first = deferredFill()
    await reload(first.fill)
    // The old content stays while the refill is in flight.
    expect(host.textContent).toBe("cart 2 clicked 1")
    expect(host.getAttribute("aria-busy")).toBe("true")
    first.resolve({ html: "<button>cart 7 clicked 0</button>", props: { count: 7 } })
    await settle(first.promise)
    expect(host.textContent).toBe("cart 7 clicked 1")
    expect(host.getAttribute("aria-busy")).toBe("false")

    const older = deferredFill()
    const newer = deferredFill()
    await reload(older.fill)
    await reload(newer.fill)
    newer.resolve({ html: "", props: { count: 9 } })
    await settle(newer.promise)
    older.resolve({ html: "", props: { count: 8 } })
    await settle(older.promise)
    expect(host.textContent).toBe("cart 9 clicked 1")
    page.unmount()
  })

  test("a refill replaces a server-only host's HTML, and a failed one shows the error slot", async () => {
    runtime({ cart: { error: false } })
    const { host, page, reload } = await hydratePage({ ...cart, interactive: false }, { count: 1 })
    await reload({ html: "<p>cart 4</p>" })
    await settle(Promise.resolve())
    expect(host.innerHTML).toBe("<p>cart 4</p>")
    const failed = deferredFill()
    await reload(failed.fill)
    failed.reject(new Error("deferred_error"))
    await settle(failed.promise)
    expect(host.textContent).toBe("This section is unavailable.")
    expect(host.hasAttribute("data-nifra-hole-error")).toBe(true)
    page.unmount()
  })

  test("an interactive hole whose refill errors loses its app, and the next refill hydrates a new one", async () => {
    runtime({ cart: { props: { count: 2 }, error: false } })
    const { host, page, reload } = await hydratePage(tally, { count: 2 })
    await click(host)
    await reload({ html: "<p>unavailable</p>", error: true })
    await settle(Promise.resolve())
    expect(host.innerHTML).toBe("<p>unavailable</p>")
    await reload({ html: await served(tally, { count: 3 }), props: { count: 3 } })
    await settle(Promise.resolve())
    expect(host.textContent).toBe("cart 3 clicked 0")
    await click(host)
    expect(host.textContent).toBe("cart 3 clicked 1")
    page.unmount()
  })

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

  test("a host the page mounts with its fill, as after a client navigation, puts that fill", async () => {
    runtime()
    const { fill, resolve, promise } = deferredFill()
    const state = { status: "pending", ppr: true, fill } as const
    const Page = defineComponent(
      () => () => h("main", null, [h(Hole, { of: { ...cart, interactive: false }, state })]),
    )
    const container = document.createElement("div")
    container.innerHTML = await renderToString(createSSRApp(Page))
    document.body.append(container)
    const app = createSSRApp(Page)
    app.mount(container)
    await nextTick()
    resolve({ html: "<p>cart 3</p>" })
    await settle(promise)
    expect(container.querySelector('[data-nifra-hole="cart"]')?.innerHTML).toBe("<p>cart 3</p>")
    app.unmount()
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
