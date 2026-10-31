import { afterAll, beforeAll, expect, test } from "bun:test"
import { href } from "@nifrajs/web"
import { GlobalWindow } from "happy-dom"
import { act, createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { installRouteSlotClientHarness } from "../../web/test/route-slot-client-harness.ts"
import { RouteSlot, useRouteSlot } from "../src/route-slot.ts"
import { RouterContext } from "../src/router.ts"

declare module "@nifrajs/web" {
  interface RouteTable {
    "/dashboard": {
      readonly params: Record<string, never>
      readonly slots: {
        readonly inspector: readonly ["/users/:id"]
        readonly activity: readonly ["/activity"]
      }
    }
    "/users/:id": { readonly params: { readonly id: string } }
    "/activity": { readonly params: Record<string, never> }
  }
}

const window = new GlobalWindow({ url: "https://route-slot.test/dashboard" })
const installed: string[] = []
let client: typeof import("react-dom/client")

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
  client = await import("react-dom/client")
})

afterAll(async () => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  for (const key of installed) Reflect.deleteProperty(globalThis, key)
  await window.happyDOM.close()
})

test("React binding subscribes, loads authorized route data, and renders the target chain", async () => {
  function Target({ data }: { readonly data: { readonly label: string } }) {
    return createElement("p", { id: "slot-ready" }, data.label)
  }

  const harness = installRouteSlotClientHarness([Target])
  const container = document.createElement("div")
  document.body.append(container)
  const root = client.createRoot(container)
  const path = "/dashboard?tab=react&slot.inspector=%2Fusers%2F7"

  function Probe() {
    const slot = useRouteSlot("inspector")
    return createElement(
      "div",
      null,
      createElement(RouteSlot, {
        name: "inspector",
        fallback: createElement("p", null, "Loading target"),
      }),
      createElement("output", { id: "slot-status" }, slot.status),
      createElement("button", {
        type: "button",
        id: "slot-navigation",
        onClick: () => {
          slot.open(href({ to: "/users/:id", params: { id: "7" } }))
          slot.close()
        },
      }),
    )
  }

  try {
    await act(async () => {
      root.render(
        createElement(
          RouterContext.Provider,
          { value: { params: {}, path, search: {}, pending: false } },
          createElement(Probe),
        ),
      )
      for (
        let attempt = 0;
        attempt < 20 && document.querySelector("#slot-ready") === null;
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.querySelector("#slot-ready")?.textContent).toBe("authorized target")
    expect(document.querySelector("#slot-status")?.textContent).toBe("ready")
    expect(harness.requests).toHaveLength(1)

    await act(async () => {
      document.querySelector<HTMLButtonElement>("#slot-navigation")?.click()
    })
  } finally {
    await act(async () => root.unmount())
    container.remove()
    harness.restore()
  }
})

test("React binding exposes parse errors through default and custom error states", () => {
  const value = {
    params: {},
    path: "/dashboard?slot.inspector=not-a-path",
    search: {},
    pending: false,
  }
  const render = (error?: ReactNode) =>
    createElement(
      RouterContext.Provider,
      { value },
      createElement(
        RouteSlot,
        error === undefined ? { name: "inspector" } : { name: "inspector", error },
      ),
    )

  expect(renderToStaticMarkup(render())).toContain('data-route-slot-error="invalid_target"')
  expect(renderToStaticMarkup(render(createElement("strong", null, "Try again")))).toContain(
    "Try again",
  )
  expect(
    renderToStaticMarkup(
      createElement(
        RouterContext.Provider,
        { value },
        createElement(RouteSlot, {
          name: "inspector",
          error: (code) => createElement("strong", null, code),
        }),
      ),
    ),
  ).toContain("invalid_target")
  expect(
    renderToStaticMarkup(
      createElement(
        RouterContext.Provider,
        { value: { ...value, path: "/dashboard" } },
        createElement(RouteSlot, { name: "inspector" }),
      ),
    ),
  ).toBe("")
})
