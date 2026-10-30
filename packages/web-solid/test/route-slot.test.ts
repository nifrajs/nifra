import { expect, test } from "bun:test"
import type { RenderProps, RouteSlotName } from "@nifrajs/web"
import { createComponent } from "solid-js"
import { Dynamic, renderToString } from "solid-js/web"
import { RouteSlot } from "../src/route-slot.tsx"
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
    path: `/dashboard?__nifra_slots=${encodeURIComponent('{"v":1,"slots":{"inspector":"/users/7"}}')}`,
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
