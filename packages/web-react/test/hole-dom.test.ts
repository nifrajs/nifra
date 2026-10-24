import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createSlotParking, PAGE_HIDE_EVENT, PAGE_SHOW_EVENT } from "@nifrajs/web/keep-alive"
import { GlobalWindow } from "happy-dom"
import * as React from "react"
import { act, type ComponentType, createElement, type ReactNode, useState } from "react"
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
  const left = { count: 0 }
  const api = Object.assign(() => {}, {
    leave() {
      left.count++
    },
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
  return { waiting, unsubscribed, left }
}

function Counter(props: { readonly start: number }): ReactNode {
  const [count, setCount] = useState(props.start)
  return createElement(
    "button",
    { type: "button", onClick: () => setCount(count + 1) },
    `cart ${count}`,
  )
}

/** Shows the props it was given beside a click count only the component holds. */
function Tally(props: { readonly count: number }): ReactNode {
  const [clicks, setClicks] = useState(0)
  return createElement(
    "button",
    { type: "button", onClick: () => setClicks(clicks + 1) },
    `cart ${props.count} clicked ${clicks}`,
  )
}

const tally: HoleDefinition<{ readonly count: number }> = {
  name: "cart",
  interactive: true,
  render: (data) => createElement(Tally, { count: data.count }),
}

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

/** The page re-rendered with a reloaded state for its hole, as the router publishes it. */
const reload = async (root: Root, of: HoleDefinition<{ readonly count: number }>, fill: unknown) =>
  act(async () => {
    root.render(
      createElement(Hole<{ readonly count: number }>, {
        of,
        state: { status: "pending", ppr: true, fill },
      }),
    )
  })

/** Lets a settled fill's promise reactions, and the renders they start, run. */
const settle = async (promise: Promise<unknown>) =>
  act(async () => {
    await promise.catch(() => {})
  })

/** Unmounts a page, then waits the task a hole's own root takes to unmount after it. */
const unmount = async (root: Root | undefined) => {
  await act(async () => root?.unmount())
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

/** The event a keep-alive view sends from a page it hides or shows, made by the document (Bun's own
 * event class is not one happy-dom dispatches). */
const pageEvent = (type: string): Event => {
  const event = document.createEvent("Event")
  event.initEvent(type, true, false)
  return event
}
const pageHide = (): Event => pageEvent(PAGE_HIDE_EVENT)

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

  test("a blocking render's settled fill is the host's server HTML", () => {
    const html = server.renderToString(
      createElement(Hole<{ readonly count: number }>, {
        of: { ...cart, interactive: false },
        state: { status: "pending", ppr: true, fill: { v: 1, html: "<p>held</p>" } },
      }),
    )
    expect(html).toBe('<div data-nifra-hole="cart" aria-busy="true"><p>held</p></div>')
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
  test("a refill re-renders an interactive root with new props and keeps its state; an older one is dropped", async () => {
    runtime({ cart: { props: { count: 2 }, error: false } })
    const { host, root } = await hydratePage(tally, { count: 2 })
    await click(host)
    expect(host.textContent).toBe("cart 2 clicked 1")
    const first = deferredFill()
    await reload(root, tally, first.fill)
    // The old content stays while the refill is in flight.
    expect(host.textContent).toBe("cart 2 clicked 1")
    expect(host.getAttribute("aria-busy")).toBe("true")
    first.resolve({ html: "<button>cart 7 clicked 0</button>", props: { count: 7 } })
    await settle(first.promise)
    expect(host.textContent).toBe("cart 7 clicked 1")
    expect(host.getAttribute("aria-busy")).toBe("false")

    const older = deferredFill()
    const newer = deferredFill()
    await reload(root, tally, older.fill)
    await reload(root, tally, newer.fill)
    newer.resolve({ html: "", props: { count: 9 } })
    await settle(newer.promise)
    older.resolve({ html: "", props: { count: 8 } })
    await settle(older.promise)
    expect(host.textContent).toBe("cart 9 clicked 1")
    await unmount(root)
  })

  test("a kept page hidden behind another leaves the document's holes and drops the refill on its way", async () => {
    const { left } = runtime({ cart: { props: { count: 2 }, error: false } })
    const { host, root, container } = await hydratePage(tally, { count: 2 })
    await click(host)
    const inflight = deferredFill()
    await reload(root, tally, inflight.fill)
    const other = document.createElement("section")
    document.body.append(other)
    other.dispatchEvent(pageHide())
    expect(left.count).toBe(0)
    container.dispatchEvent(pageHide())
    expect(left.count).toBe(1)
    inflight.resolve({ html: "", props: { count: 7 } })
    await settle(inflight.promise)
    expect(host.textContent).toBe("cart 2 clicked 1")
    expect(host.getAttribute("aria-busy")).toBe("true")
    // Shown again: the page's reload refills the host in place.
    await reload(root, tally, { html: "", props: { count: 8 } })
    await settle(Promise.resolve())
    expect(host.textContent).toBe("cart 8 clicked 1")
    expect(host.getAttribute("aria-busy")).toBe("false")
    await unmount(root)
    other.dispatchEvent(pageHide())
    container.dispatchEvent(pageHide())
    expect(left.count).toBe(1)
    other.remove()
  })

  test("a host its kept page hides behind Activity keeps its root and state, until the page is dropped", async () => {
    runtime({ cart: { props: { count: 2 }, error: false } })
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: React 19.2's own export, which the keep-alive mount renders
    const Activity = Reflect.get(React, "Activity") as ComponentType<{
      readonly mode: "hidden" | "visible"
      readonly children?: ReactNode
    }>
    const page = (mode: "hidden" | "visible", fill?: unknown) =>
      createElement(
        "section",
        null,
        createElement(
          Activity,
          { mode },
          createElement(Hole<{ readonly count: number }>, {
            of: tally,
            state: { status: "pending", ppr: true, fill },
          }),
        ),
      )
    const container = document.createElement("main")
    container.innerHTML = server.renderToString(page("visible"))
    document.body.append(container)
    const kept = container.querySelector("section")
    const host = container.querySelector('[data-nifra-hole="cart"]')
    if (kept === null || host === null) throw new Error("the shell has no host")
    host.innerHTML = server.renderToString(tally.render({ count: 2 }), {
      identifierPrefix: "nifra-cart-",
    })
    let root: Root | undefined
    await act(async () => {
      root = client.hydrateRoot(container, page("visible"))
    })
    await click(host)
    const hide = async () => {
      kept.dispatchEvent(pageHide())
      await act(async () => root?.render(page("hidden")))
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    }
    await hide()
    expect(host.textContent).toBe("cart 2 clicked 1")
    kept.dispatchEvent(pageEvent(PAGE_SHOW_EVENT))
    await act(async () => root?.render(page("visible", { html: "", props: { count: 5 } })))
    await settle(Promise.resolve())
    expect(host.textContent).toBe("cart 5 clicked 1")
    await click(host)
    expect(host.textContent).toBe("cart 5 clicked 2")

    // Hidden again, then dropped: the view's slot leaves, and the host's root goes with it.
    const parking = createSlotParking()
    parking.page("\0kept")(kept)
    await hide()
    expect(host.textContent).toBe("cart 5 clicked 2")
    parking.after([])
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(host.textContent).toBe("")
    await unmount(root)
    container.remove()
  })

  test("a refill replaces a server-only host's HTML, and a failed one shows the error slot", async () => {
    runtime({ cart: { error: false } })
    const inert = { ...cart, interactive: false }
    const { host, root } = await hydratePage(inert, { count: 1 })
    expect(host.textContent).toBe("cart 1")
    await reload(root, inert, { html: "<p>cart 4</p>" })
    await settle(Promise.resolve())
    expect(host.innerHTML).toBe("<p>cart 4</p>")

    const failed = deferredFill()
    await reload(root, inert, failed.fill)
    failed.reject(new Error("deferred_error"))
    await settle(failed.promise)
    expect(host.textContent).toBe("This section is unavailable.")
    expect(host.hasAttribute("data-nifra-hole-error")).toBe(true)
    await unmount(root)
  })

  test("an interactive hole whose refill errors loses its root, and the next refill hydrates a new one", async () => {
    runtime({ cart: { props: { count: 2 }, error: false } })
    const { host, root } = await hydratePage(tally, { count: 2 })
    await click(host)
    await reload(root, tally, { html: "<p>unavailable</p>", error: true })
    await settle(Promise.resolve())
    expect(host.innerHTML).toBe("<p>unavailable</p>")
    const served = server.renderToString(tally.render({ count: 3 }), {
      identifierPrefix: "nifra-cart-",
    })
    await reload(root, tally, { html: served, props: { count: 3 } })
    await settle(Promise.resolve())
    expect(host.textContent).toBe("cart 3 clicked 0")
    expect(host.hasAttribute("data-nifra-hole-error")).toBe(false)
    await click(host)
    expect(host.textContent).toBe("cart 3 clicked 1")
    await unmount(root)
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
