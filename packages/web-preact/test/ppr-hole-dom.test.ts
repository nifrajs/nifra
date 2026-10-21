import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { GlobalWindow } from "happy-dom"
import { h, hydrate, render } from "preact"
import { useId, useState } from "preact/hooks"
import { act } from "preact/test-utils"
import { renderToString } from "preact-render-to-string"
import { idScope } from "../src/id-scope.ts"
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

function Counter(props: { readonly start: number }) {
  const [count, setCount] = useState(props.start)
  return h("button", { id: useId(), type: "button", onClick: () => setCount(count + 1) }, [
    "cart ",
    count,
  ])
}

type Cart = { readonly count: number }
const cart: HoleDefinition<Cart> = {
  name: "cart",
  interactive: true,
  render: (data) => h(Counter, { start: data.count }),
  fallback: h("p", null, "loading cart"),
}

/** The hole's HTML as the server renders it into its frame. */
const served = (of: HoleDefinition<Cart>, data: Cart) =>
  renderToString(idScope(of.render(data), `nifra-${of.name}-`))

/**
 * The page as the shell left it, hydrated: the host holds the server's HTML for `data`, as the runtime
 * writes it before the page's own root hydrates.
 */
function hydratePage(of: HoleDefinition<Cart>, data?: Cart) {
  const props: HoleProps<Cart> = { of, state: { status: "pending", ppr: true } }
  const container = document.createElement("main")
  container.innerHTML = renderToString(h(Hole<Cart>, props))
  document.body.append(container)
  const host = container.querySelector(`[data-nifra-hole="${of.name}"]`)
  if (host === null) throw new Error("the shell has no host")
  if (data !== undefined) host.innerHTML = served(of, data)
  act(() => hydrate(h(Hole<Cart>, props), container))
  return { host, container, props }
}

const unmount = (container: Element) => act(() => render(null, container))

const click = (host: Element) => act(() => host.querySelector("button")?.click())

describe("Hole in the browser", () => {
  test("an interactive hole whose fill arrived first hydrates its server HTML as its own root", () => {
    const fill = { props: { count: 2 }, error: false }
    runtime({ cart: fill })
    const { host, container, props } = hydratePage(cart, fill.props)
    const button = host.querySelector("button")
    expect(button?.id).toBe("Pnifra-cart--0")
    click(host)
    expect(host.textContent).toBe("cart 3")
    expect(host.querySelector("button")).toBe(button)
    // The page rendering again leaves the host's children to the hole's own root.
    act(() => render(h(Hole<Cart>, props), container))
    expect(host.textContent).toBe("cart 3")
    unmount(container)
  })

  test("a hole that is still loading hydrates when its fill arrives, and stops waiting on unmount", () => {
    const { waiting, unsubscribed } = runtime()
    const fill = { props: { count: 5 }, error: false }
    const { host, container } = hydratePage(cart)
    const deliver = waiting.get("cart")
    expect(deliver).toBeDefined()
    host.innerHTML = served(cart, fill.props)
    act(() => deliver?.(fill))
    click(host)
    expect(host.textContent).toBe("cart 6")
    unmount(container)
    expect(unsubscribed).toEqual(["cart"])
    expect(host.childNodes.length).toBe(0)
  })

  test("a failed fill, a non-interactive hole and a page without the runtime hydrate nothing", () => {
    const failed = runtime({ cart: { error: true } })
    const broken = hydratePage(cart)
    expect(broken.host.innerHTML).toBe("")
    expect(failed.waiting.size).toBe(0)
    unmount(broken.container)

    const fill = { props: { count: 1 }, error: false }
    runtime({ cart: fill })
    const inert = hydratePage({ ...cart, interactive: false }, fill.props)
    click(inert.host)
    expect(inert.host.textContent).toBe("cart 1")
    unmount(inert.container)

    Reflect.deleteProperty(globalThis, "__nifraPpr")
    const bare = hydratePage(cart, fill.props)
    click(bare.host)
    expect(bare.host.textContent).toBe("cart 1")
    unmount(bare.container)
  })

  test("after a client navigation, a hole whose deferred data rejects shows its error", async () => {
    const container = document.createElement("main")
    document.body.append(container)
    const failure = Promise.reject(new Error("cart service down"))
    failure.catch(() => {})
    await act(async () => {
      render(
        h(Hole<Cart>, {
          of: cart,
          state: { status: "pending", data: { __nifra_deferred: true, promise: failure } },
          error: h("p", { id: "cart-error" }, "cart unavailable"),
        }),
        container,
      )
    })
    await act(async () => {
      await failure.catch(() => {})
    })
    expect(container.querySelector("#cart-error")?.textContent).toBe("cart unavailable")
    unmount(container)
  })

  test("the browser checks' product page hydrates its interactive cart hole", async () => {
    const page = await import("./fixtures/ppr-app/routes/p/[id].tsx")
    const states = (cart: {
      readonly status: "pending" | "ready"
      readonly data?: unknown
      readonly ppr?: true
    }) => ({
      data: { title: "Product 1" },
      boundaries: {
        greeting: { status: "pending" as const, ppr: true as const },
        cart,
        slow: { status: "pending" as const, ppr: true as const },
      },
    })
    const cartHole = page.boundaries.find((hole) => hole.name === "cart")
    if (cartHole === undefined || !("interactive" in cartHole)) throw new Error("no cart hole")
    runtime({ cart: { props: { count: 2 }, error: false } })
    const shell = states({ status: "pending", ppr: true })
    const container = document.createElement("main")
    container.innerHTML = renderToString(h(page.default, shell))
    document.body.append(container)
    const host = container.querySelector('[data-nifra-hole="cart"]')
    if (host === null) throw new Error("the shell has no cart host")
    host.innerHTML = renderToString(idScope(cartHole.render({ count: 2 }), "nifra-cart-"))
    act(() => hydrate(h(page.default, shell), container))
    click(host)
    expect(host.textContent).toBe("cart 3")
    unmount(container)
  })
})
