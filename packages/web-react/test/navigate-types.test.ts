import { afterEach, expect, test } from "bun:test"
import { href, setBrowserNavigate } from "@nifrajs/web"
import { renderToStaticMarkup } from "react-dom/server"
import { compose } from "../src/compose.ts"
import { type NavigateFunction, useNavigate } from "../src/router.ts"

// The navigate bridge is a module singleton shared across the whole test process; reset it so this
// file's registration can't leak into another file's bridge-dependent test.
afterEach(() => setBrowserNavigate(undefined))

// Augment the route table exactly as `nifra types` (`.nifra/types/routes.d.ts`) does, so the typed
// cross-route navigate can be asserted here. A pattern unused by the other tests, so the global-per-
// compilation augmentation collides with nothing. This file's `@ts-expect-error` lines are verified by the
// typecheck gate: if the wrong-shape call ever stopped being an error, tsc would fail on the unused marker.
declare module "@nifrajs/web" {
  interface RouteTable {
    "/typed-only": {
      readonly params: Record<string, never>
      readonly search: { readonly page: number }
    }
  }
}

test("navigate takes an href() URL, typed against the generated RouteTable", () => {
  const calls: Array<[string | number, unknown]> = []
  setBrowserNavigate((to, o) => calls.push([to, o]))
  let nav: NavigateFunction | undefined
  const Page = () => {
    nav = useNavigate()
    return null
  }
  renderToStaticMarkup(compose([Page], { data: null }))

  nav?.(href({ to: "/typed-only", search: { page: 5 } }))
  // @ts-expect-error - page must be a number for /typed-only (a stale shape is a tsc error, the drift guarantee).
  nav?.(href({ to: "/typed-only", search: { page: "nope" } }))
  // @ts-expect-error - a plain string is not an Href.
  nav?.("/typed-only?page=5")

  expect(calls[0]).toEqual(["/typed-only?page=5", undefined])
})
