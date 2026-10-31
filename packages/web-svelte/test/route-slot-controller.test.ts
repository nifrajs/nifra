import { expect, mock, test } from "bun:test"
import { href, type RouteSlotName, setBrowserNavigate } from "@nifrajs/web"

declare module "@nifrajs/web" {
  interface RouteTable {
    "/dashboard": { readonly slots: { readonly inspector: readonly ["/users/:id"] } }
    "/users/:id": { readonly params: { readonly id: string } }
  }
}

test("useRouteSlot reads the scoped URL and edits only its own slot", async () => {
  const navigations: string[] = []
  let path = "http://["
  mock.module("svelte", () => ({
    getContext(key: string) {
      return key === "@nifrajs/web-svelte:props" ? () => ({ path }) : undefined
    },
  }))
  setBrowserNavigate((to) => navigations.push(String(to)))
  try {
    const { useRouteSlot } = await import("../src/route-slot.ts")
    const slot = useRouteSlot("inspector" satisfies RouteSlotName)
    expect(slot.target).toBeUndefined()
    path = "/dashboard?tab=svelte&slot.inspector=%2Fusers%2F7"
    expect(slot.target).toBe("/users/7")
    slot.open(href({ to: "/users/:id", params: { id: "8" } }))
    slot.close()
    expect(navigations).toEqual([
      "/dashboard?tab=svelte&slot.inspector=%2Fusers%2F8",
      "/dashboard?tab=svelte",
    ])
  } finally {
    setBrowserNavigate(undefined)
    mock.restore()
  }
})
