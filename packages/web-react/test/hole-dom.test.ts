import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { GlobalWindow } from "happy-dom"
import { act, createElement, type ReactNode, useState } from "react"
import type { Root } from "react-dom/client"
import type { HoleDefinition, HoleProps } from "../src/ppr.ts"

// The client half of `Hole`, in a happy-dom document: what a browser runs once the PPR runtime has put
// a hole's server HTML into its host. The browser checks in @nifrajs/web cover the real runtime.
const window = new GlobalWindow({ url: "http://shop.test/" })
const installed: string[] = []
let Hole: <Data>(props: HoleProps<Data>) => ReactNode
let client: typeof import("react-dom/client")
let server: typeof import("react-dom/server")

beforeAll(async () => {
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis) continue
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: Reflect.get(window, key),
    })
    installed.push(key)
  }
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  // After the globals: react-dom reads them when it loads.
  client = await import("react-dom/client")
  server = await import("react-dom/server")
  Hole = (await import("../src/ppr.ts")).Hole
})

afterAll(async () => {
  Reflect.deleteProperty(globalThis, "__nifraPpr")
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
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

function Counter(props: { readonly start: number }): ReactNode {
  const [count, setCount] = useState(props.start)
  return createElement(
    "button",
    { type: "button", onClick: () => setCount(count + 1) },
    `cart ${count}`,
  )
}

const cart: HoleDefinition<{ readonly count: number }> = {
  name: "cart",
  interactive: true,
  render: (data) => createElement(Counter, { start: data.count }),
  fallback: createElement("p", null, "loading cart"),
}

/**
 * The page as the shell left it, hydrated: the host holds the server's HTML for `served`, as the
 * runtime writes it before the page's own root hydrates.
 */
async function hydratePage(
  of: HoleDefinition<{ readonly count: number }>,
  served?: { readonly count: number },
) {
  const props: HoleProps<{ readonly count: number }> = {
    of,
    state: { status: "pending", ppr: true },
  }
  const container = document.createElement("main")
  container.innerHTML = server.renderToString(
    createElement(Hole<{ readonly count: number }>, props),
  )
  document.body.append(container)
  const host = container.querySelector(`[data-nifra-hole="${of.name}"]`)
  if (host === null) throw new Error("the shell has no host")
  if (served !== undefined) {
    host.innerHTML = server.renderToString(of.render(served), {
      identifierPrefix: `nifra-${of.name}-`,
    })
  }
  let root: Root | undefined
  await act(async () => {
    root = client.hydrateRoot(container, createElement(Hole<{ readonly count: number }>, props))
  })
  if (root === undefined) throw new Error("no root")
  return { host, root, container }
}

/** Unmounts a page, then waits the task a hole's own root takes to unmount after it. */
const unmount = async (root: Root | undefined) => {
  await act(async () => root?.unmount())
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

const click = async (host: Element) => {
  await act(async () => {
    host.querySelector("button")?.click()
  })
}

describe("Hole in the browser", () => {
  test("an interactive hole whose fill arrived first hydrates as its own root", async () => {
    const fill = { props: { count: 2 }, error: false }
    runtime({ cart: fill })
    const { host, root } = await hydratePage(cart, fill.props)
    expect(host.textContent).toBe("cart 2")
    await click(host)
    expect(host.textContent).toBe("cart 3")
    await unmount(root)
  })

  test("a hole that is still loading hydrates when its fill arrives, and stops waiting on unmount", async () => {
    const { waiting, unsubscribed } = runtime()
    const fill = { props: { count: 5 }, error: false }
    const { host, root } = await hydratePage(cart)
    const deliver = waiting.get("cart")
    expect(deliver).toBeDefined()
    host.innerHTML = server.renderToString(cart.render({ count: 5 }), {
      identifierPrefix: "nifra-cart-",
    })
    await act(async () => deliver?.(fill))
    await click(host)
    expect(host.textContent).toBe("cart 6")
    await unmount(root)
    expect(unsubscribed).toEqual(["cart"])
    expect(host.childNodes.length).toBe(0)
  })

  test("a failed fill, a non-interactive hole and a page without the runtime hydrate nothing", async () => {
    const failed = runtime({ cart: { error: true } })
    const broken = await hydratePage(cart)
    expect(broken.host.innerHTML).toBe("")
    expect(failed.waiting.size).toBe(0)
    await unmount(broken.root)

    const fill = { props: { count: 1 }, error: false }
    runtime({ cart: fill })
    const inert = await hydratePage({ ...cart, interactive: false }, fill.props)
    await click(inert.host)
    expect(inert.host.textContent).toBe("cart 1")
    await unmount(inert.root)

    Reflect.deleteProperty(globalThis, "__nifraPpr")
    const bare = await hydratePage(cart, fill.props)
    await click(bare.host)
    expect(bare.host.textContent).toBe("cart 1")
    await unmount(bare.root)
  })

  test("after a client navigation, a hole whose deferred data rejects shows its error", async () => {
    const container = document.createElement("main")
    document.body.append(container)
    const failure = Promise.reject(new Error("cart service down"))
    failure.catch(() => {})
    const logged: unknown[] = []
    const error = console.error
    console.error = (...args: unknown[]) => logged.push(args)
    try {
      const root = client.createRoot(container)
      await act(async () => {
        root.render(
          createElement(Hole<{ readonly count: number }>, {
            of: cart,
            state: { status: "pending", data: { __nifra_deferred: true, promise: failure } },
            error: createElement("p", { id: "cart-error" }, "cart unavailable"),
          }),
        )
      })
      expect(container.querySelector("#cart-error")?.textContent).toBe("cart unavailable")
      await unmount(root)
    } finally {
      console.error = error
    }
  })
  test("the browser checks' product page hydrates its interactive cart hole", async () => {
    const page = await import("../../web/test/fixtures/ppr/app/routes/p/[id].tsx")
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
    // The cart's server HTML, as the hole's frame carries it.
    const whole = server.renderToString(
      createElement(page.default, states({ status: "ready", data: { count: 2 } })),
    )
    const served = /<button id="cart"[\s\S]*?<\/button>/.exec(whole)?.[0]
    if (served === undefined) throw new Error("the page rendered no cart")
    runtime({ cart: { props: { count: 2 }, error: false } })
    const shell = states({ status: "pending", ppr: true })
    const container = document.createElement("main")
    container.innerHTML = server.renderToString(createElement(page.default, shell))
    document.body.append(container)
    const host = container.querySelector('[data-nifra-hole="cart"]')
    if (host === null) throw new Error("the shell has no cart host")
    host.innerHTML = served
    let root: Root | undefined
    await act(async () => {
      root = client.hydrateRoot(container, createElement(page.default, shell))
    })
    await click(host)
    expect(host.textContent).toBe("cart 3")
    await unmount(root)
  })
})
