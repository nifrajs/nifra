import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { href, type RouteSlotName } from "@nifrajs/web"
import { createRouteSlotController } from "../src/route-slot.ts"

declare module "@nifrajs/web" {
  interface RouteTable {
    "/dashboard": { readonly slots: { readonly inspector: readonly ["/users/:id"] } }
    "/users/:id": { readonly params: { readonly id: string } }
  }
}

test("useRouteSlot reads the scoped URL and edits only its own slot", () => {
  const navigations: string[] = []
  let path = "http://["
  const slot = createRouteSlotController(
    "inspector" satisfies RouteSlotName,
    () => path,
    (to) => navigations.push(String(to)),
  )
  expect(slot.target).toBeUndefined()
  path = "/dashboard?slot.inspector=%"
  expect(slot.target).toBeUndefined()
  path = "/dashboard?tab=svelte&slot.inspector=%2Fusers%2F7"
  expect(slot.target).toBe("/users/7")
  slot.open(href({ to: "/users/:id", params: { id: "8" } }))
  slot.close()
  expect(navigations).toEqual([
    "/dashboard?tab=svelte&slot.inspector=%2Fusers%2F8",
    "/dashboard?tab=svelte",
  ])
})

test("useRouteSlot reads route props from Svelte context", async () => {
  const { compile } = await import("svelte/compiler")
  const { render } = await import("svelte/server")
  const source = `<script>
    import { useRouteSlot } from ${JSON.stringify(new URL("../src/route-slot.ts", import.meta.url).href)}
    const slot = useRouteSlot("inspector")
  </script>
  <p>{slot.target ?? "closed"}</p>`
  const dir = await mkdtemp(join(import.meta.dir, ".tmp-nifra-route-slot-probe-"))
  try {
    const file = join(dir, "probe.js")
    await writeFile(file, compile(source, { generate: "server", filename: "Probe.svelte" }).js.code)
    const Probe = (await import(file)).default
    const context = new Map([
      [
        "@nifrajs/web-svelte:props",
        () => ({ data: null, path: "/dashboard?slot.inspector=%2Fusers%2F7", pending: false }),
      ],
    ])
    expect(render(Probe, { context }).body).toContain("<p>/users/7</p>")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
