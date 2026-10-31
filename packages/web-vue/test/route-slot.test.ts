import { expect, test } from "bun:test"
import { type RenderProps, type RouteSlotName, setBrowserNavigate } from "@nifrajs/web"
import { GlobalWindow } from "happy-dom"
import { createSSRApp, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { RouteSlot, type RouteSlotController, useRouteSlot } from "../src/route-slot.ts"
import { RenderPropsProvider } from "../src/router.ts"

declare module "@nifrajs/web" {
  interface RouteTable {
    "/dashboard": { readonly slots: { readonly inspector: readonly ["/users/:id"] } }
    "/users/:id": object
  }
}

test("RouteSlot renders its fallback while a URL-addressed target loads", async () => {
  const props: RenderProps = {
    data: null,
    path: "/dashboard?slot.inspector=%2Fusers%2F7",
  }
  const app = createSSRApp({
    render: () =>
      h(
        RenderPropsProvider,
        { value: props },
        {
          default: () =>
            h(
              RouteSlot,
              { name: "inspector" satisfies RouteSlotName },
              { fallback: () => h("p", null, "Select a user.") },
            ),
        },
      ),
  })

  expect(await renderToString(app)).toContain("<p>Select a user.</p>")
})

test("RouteSlot renders a stable error and its custom error slot for malformed state", async () => {
  const props: RenderProps = {
    data: null,
    path: "/dashboard?slot.inspector=%2Fusers%2F7&slot.inspector=%2Fusers%2F8",
  }
  const render = async (custom = false): Promise<string> => {
    const app = createSSRApp({
      render: () =>
        h(
          RenderPropsProvider,
          { value: props },
          {
            default: () =>
              h(
                RouteSlot,
                { name: "inspector" satisfies RouteSlotName },
                custom ? { error: ({ code }) => h("strong", null, code) } : {},
              ),
          },
        ),
    })
    return renderToString(app)
  }

  expect(await render()).toContain('role="alert"')
  expect(await render(true)).toContain("malformed")
})

test("Vue binding subscribes to the shared slot store and navigates only its own query key", async () => {
  const browser = new GlobalWindow({ url: "https://route-slot.test/dashboard" })
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const props: RenderProps = {
    data: null,
    path: "/dashboard?tab=vue&slot.inspector=%2Fusers%2F7",
  }
  const navigations: string[] = []
  let controller: RouteSlotController | undefined
  const Probe = {
    setup() {
      controller = useRouteSlot("inspector")
      return () => null
    },
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: browser,
  })
  setBrowserNavigate((to) => navigations.push(String(to)))
  try {
    const app = createSSRApp({
      render: () => h(RenderPropsProvider, { value: props }, { default: () => h(Probe) }),
    })
    await renderToString(app)
    expect(controller?.target.value).toBe("/users/7")
    controller?.open("/users/9")
    controller?.close()
    expect(navigations).toEqual([
      "/dashboard?tab=vue&slot.inspector=%2Fusers%2F9",
      "/dashboard?tab=vue",
    ])
  } finally {
    setBrowserNavigate(undefined)
    if (beforeWindow === undefined) Reflect.deleteProperty(globalThis, "window")
    else Object.defineProperty(globalThis, "window", beforeWindow)
    await browser.happyDOM.close()
  }
})
