import { expect, test } from "bun:test"
import type { RenderProps, RouteSlotName } from "@nifrajs/web"
import { createSSRApp, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { RouteSlot } from "../src/route-slot.ts"
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
    path: `/dashboard?__nifra_slots=${encodeURIComponent('{"v":1,"slots":{"inspector":"/users/7"}}')}`,
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
