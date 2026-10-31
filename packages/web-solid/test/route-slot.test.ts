import { expect, test } from "bun:test"
import { type RenderProps, type RouteSlotName, setBrowserNavigate } from "@nifrajs/web"
import { createComponent, type JSX } from "solid-js"
import { Dynamic, renderToString } from "solid-js/web"
import { RouteSlot, type RouteSlotController, useRouteSlot } from "../src/route-slot.tsx"
import { RenderPropsContext } from "../src/router.ts"

declare module "@nifrajs/web" {
  interface RouteTable {
    "/dashboard": { readonly slots: { readonly inspector: readonly ["/users/:id"] } }
    "/users/:id": object
  }
}

test("RouteSlot renders its fallback while a URL-addressed target loads", () => {
  const props: RenderProps = {
    data: null,
    path: "/dashboard?slot.inspector=%2Fusers%2F7",
  }
  const markup = renderToString(() =>
    createComponent(RenderPropsContext.Provider, {
      value: props,
      get children() {
        return createComponent(RouteSlot, {
          name: "inspector" satisfies RouteSlotName,
          fallback: createComponent(Dynamic, { component: "p", children: "Select a user." }),
        })
      },
    }),
  )

  expect(markup).toMatch(/<p(?:\s[^>]*)?>Select a user\.<\/p>/)
})

test("RouteSlot renders the stable error and custom error view for malformed state", () => {
  const props: RenderProps = {
    data: null,
    path: "/dashboard?slot.inspector=%2Fusers%2F7&slot.inspector=%2Fusers%2F8",
  }
  const render = (error?: (code: string) => JSX.Element): string =>
    renderToString(() =>
      createComponent(RenderPropsContext.Provider, {
        value: props,
        get children() {
          return createComponent(
            RouteSlot,
            error === undefined
              ? { name: "inspector" satisfies RouteSlotName }
              : { name: "inspector" satisfies RouteSlotName, error },
          )
        },
      }),
    )

  expect(render()).toContain('role="alert"')
  expect(
    render((code) => createComponent(Dynamic, { component: "strong", children: code })),
  ).toContain("malformed")
})

test("useRouteSlot open and close preserve the page and sibling query state", () => {
  const calls: string[] = []
  const props: RenderProps = {
    data: null,
    path: "/dashboard?tab=activity&slot.inspector=%2Fusers%2F7",
  }
  let controller: RouteSlotController | undefined
  const Capture = (): null => {
    controller = useRouteSlot("inspector")
    return null
  }
  setBrowserNavigate((to) => calls.push(String(to)))
  renderToString(() =>
    createComponent(RenderPropsContext.Provider, {
      value: props,
      get children() {
        return createComponent(Capture, {})
      },
    }),
  )
  controller?.open("/users/8")
  controller?.close()
  setBrowserNavigate(undefined)

  expect(calls).toEqual([
    "/dashboard?tab=activity&slot.inspector=%2Fusers%2F8",
    "/dashboard?tab=activity",
  ])
})
