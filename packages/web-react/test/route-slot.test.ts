import { expect, test } from "bun:test"
import type { RouteSlotName } from "@nifrajs/web"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RouteSlot } from "../src/route-slot.ts"
import { RouterContext } from "../src/router.ts"

declare module "@nifrajs/web" {
  interface RouteTable {
    "/dashboard": { readonly slots: { readonly inspector: readonly ["/users/:id"] } }
    "/users/:id": object
  }
}

test("RouteSlot renders its fallback while a URL-addressed target loads", () => {
  const path = `/dashboard?__nifra_slots=${encodeURIComponent('{"v":1,"slots":{"inspector":"/users/7"}}')}`
  const markup = renderToStaticMarkup(
    createElement(
      RouterContext.Provider,
      { value: { params: {}, path, search: {}, pending: false } },
      createElement(RouteSlot, {
        name: "inspector" satisfies RouteSlotName,
        fallback: createElement("p", null, "Select a user."),
      }),
    ),
  )

  expect(markup).toBe("<p>Select a user.</p>")
})
