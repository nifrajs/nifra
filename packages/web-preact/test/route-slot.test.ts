import { expect, test } from "bun:test"
import type { RenderProps, RouteSlotName } from "@nifrajs/web"
import { h } from "preact"
import { renderToString } from "preact-render-to-string"
import { RouteSlot } from "../src/route-slot.ts"
import { RenderPropsContext } from "../src/router.ts"

declare module "@nifrajs/web" {
  interface RouteTable {
    "/dashboard": { readonly slots: { readonly inspector: readonly ["/users/:id"] } }
    "/users/:id": object
  }
}

test("RouteSlot renders its fallback without adding a wrapper element", () => {
  const props: RenderProps = {
    data: null,
    path: `/dashboard?__nifra_slots=${encodeURIComponent(
      JSON.stringify({
        v: 1,
        slots: { inspector: "/users/7" },
      }),
    )}`,
  }
  const markup = renderToString(
    h(
      RenderPropsContext.Provider,
      { value: props },
      h(RouteSlot, {
        name: "inspector" satisfies RouteSlotName,
        fallback: h("p", null, "Select a user."),
      }),
    ),
  )

  expect(markup).toBe("<p>Select a user.</p>")
})
