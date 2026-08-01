import { afterEach, expect, test } from "bun:test"
import { setBrowserNavigate } from "@nifrajs/web"
import { renderToStaticMarkup } from "react-dom/server"
import { compose } from "../src/compose.ts"
import { type NavigateFunction, useNavigate } from "../src/router.ts"

// The navigate bridge is a module singleton shared across the whole test process; reset it so this
// file's registration can't leak into another file's bridge-dependent test.
afterEach(() => setBrowserNavigate(undefined))

// Augment the route -> search map exactly as `nifra sync-routes` (generateRouteSearchTypes) would, so the
// typed cross-route navigate can be asserted here. A path unused by the other tests, so the global-per-
// compilation augmentation collides with nothing. This file's `@ts-expect-error` lines are verified by the
// typecheck gate: if the wrong-shape call ever stopped being an error, tsc would fail on the unused marker.
declare module "@nifrajs/web" {
  interface RouteSearch {
    "/typed-only": { readonly page: number }
  }
}

test("navigate({ to, search }) is typed against the generated RouteSearch map", () => {
  const calls: Array<[string | number, unknown]> = []
  setBrowserNavigate((to, o) => calls.push([to, o]))
  let nav: NavigateFunction | undefined
  const Page = () => {
    nav = useNavigate()
    return null
  }
  renderToStaticMarkup(compose([Page], { data: null }))

  // A mapped route: `search` is typed to that route's schema output.
  nav?.({ to: "/typed-only", search: { page: 5 } })
  // @ts-expect-error - page must be a number for /typed-only (a stale shape is a tsc error, the drift guarantee).
  nav?.({ to: "/typed-only", search: { page: "nope" } })
  // An unmapped path keeps the loose form (any search), so navigation is never blocked on a missing entry.
  nav?.({ to: "/anything", search: { whatever: true } })

  expect(calls[0]).toEqual(["/typed-only?page=5", undefined])
  expect(calls[2]).toEqual(["/anything?whatever=true", undefined])
})
