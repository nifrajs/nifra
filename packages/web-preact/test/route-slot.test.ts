import { expect, test } from "bun:test"
import type { RenderProps, RouteSlotName } from "@nifrajs/web"
import { h } from "preact"
import { renderToString } from "preact-render-to-string"
import { RouteSlot } from "../src/route-slot.ts"
import { RenderPropsContext } from "../src/router.ts"

declare module "@nifrajs/web" {
  interface RouteTable {
    "/dashboard": { readonly slots: { readonly inspector: readonly ["/users/:id"] } }
    "/users/:id": { readonly params: { readonly id: string } }
  }
}

test("RouteSlot renders its fallback without adding a wrapper element", () => {
  const props: RenderProps = {
    data: null,
    path: "/dashboard?slot.inspector=%2Fusers%2F7",
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

test("RouteSlot renders stable and custom errors for malformed slot state", () => {
  const props: RenderProps = {
    data: null,
    path: "/dashboard?slot.inspector=%2Fusers%2F7&slot.inspector=%2Fusers%2F8",
  }
  const render = (error?: (code: string) => ReturnType<typeof h>): string =>
    renderToString(
      h(
        RenderPropsContext.Provider,
        { value: props },
        h(
          RouteSlot,
          error === undefined
            ? { name: "inspector" satisfies RouteSlotName }
            : { name: "inspector" satisfies RouteSlotName, error },
        ),
      ),
    )

  expect(render()).toContain('role="alert"')
  expect(render((code) => h("strong", null, code))).toContain("malformed")
})
