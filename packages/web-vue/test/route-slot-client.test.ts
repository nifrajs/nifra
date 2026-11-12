import { afterAll, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { href } from "@nifrajs/web"
import { GlobalWindow } from "happy-dom"
import { installRouteSlotClientHarness } from "../../web/test/route-slot-client-harness.ts"

declare module "@nifrajs/web" {
  interface RouteTable {
    "/dashboard": { readonly slots: { readonly inspector: readonly ["/users/:id"] } }
    "/users/:id": { readonly params: { readonly id: string } }
  }
}

if (process.env.NIFRA_ROUTE_SLOT_CLIENT_CHILD === "1") {
  const browser = new GlobalWindow({ url: "https://route-slot.test/dashboard" })
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  const installedGlobals: string[] = []
  for (const key of Object.getOwnPropertyNames(browser)) {
    if (key in globalThis) continue
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: Reflect.get(browser, key),
    })
    installedGlobals.push(key)
  }
  Reflect.set(globalThis, "window", browser)
  Reflect.set(globalThis, "document", browser.document)

  // Vue captures DOM capabilities when its runtime-dom module is first imported.
  const { createApp, defineComponent, h, nextTick, shallowRef } = await import("vue")
  const { RouteSlot, useRouteSlot } = await import("../src/route-slot.ts")
  const { RenderPropsProvider } = await import("../src/router.ts")

  afterAll(async () => {
    for (const key of installedGlobals) Reflect.deleteProperty(globalThis, key)
    if (beforeWindow === undefined) Reflect.deleteProperty(globalThis, "window")
    else Object.defineProperty(globalThis, "window", beforeWindow)
    if (beforeDocument === undefined) Reflect.deleteProperty(globalThis, "document")
    else Object.defineProperty(globalThis, "document", beforeDocument)
    await browser.happyDOM.close()
  })

  test("Vue binding loads the target chain, preserves its view, and handles errors", async () => {
    const Target = defineComponent({
      props: { data: { type: Object, required: true } },
      setup(props) {
        return () => h("p", { id: "slot-ready" }, Reflect.get(props.data, "label"))
      },
    })
    const harness = installRouteSlotClientHarness([Target])
    const location = shallowRef({
      data: null,
      path: "/dashboard?tab=vue&slot.inspector=%2Fusers%2F7",
      pending: false,
    })
    const container = document.createElement("div")
    document.body.append(container)

    const Probe = defineComponent({
      setup() {
        const slot = useRouteSlot("inspector")
        return () =>
          h("main", [
            h(RouteSlot, { name: "inspector" }, { fallback: () => h("p", null, "Loading target") }),
            h("output", { id: "slot-status" }, slot.status.value),
            h(
              "button",
              {
                id: "slot-navigation",
                onClick: () => {
                  slot.open(href({ to: "/users/:id", params: { id: "7" } }))
                  slot.close()
                },
              },
              "navigate",
            ),
            h(
              RouteSlot,
              { name: "inspector" },
              {
                error: ({ code }: { readonly code: string }) =>
                  h("strong", { id: "slot-error" }, code),
              },
            ),
          ])
      },
    })
    const Root = defineComponent({
      setup: () => () =>
        h(RenderPropsProvider, { value: location.value }, { default: () => h(Probe) }),
    })
    const app = createApp(Root)

    try {
      app.mount(container)
      await new Promise((resolve) => setTimeout(resolve, 20))
      await nextTick()
      expect(container.querySelector("#slot-ready")?.textContent).toBe("authorized target")
      expect(container.querySelector("#slot-status")?.textContent).toBe("ready")
      expect(harness.requests).toHaveLength(1)
      container.querySelector<HTMLButtonElement>("#slot-navigation")?.click()

      location.value = {
        data: null,
        path: "/dashboard?slot.inspector=not-a-path",
        pending: false,
      }
      await nextTick()
      expect(container.querySelector("#slot-error")?.textContent).toBe("invalid_target")
      expect(container.querySelector('[data-route-slot-error="invalid_target"]')).not.toBeNull()
    } finally {
      app.unmount()
      container.remove()
      harness.restore()
    }
  })
} else {
  test("Vue route-slot browser behavior runs with a fresh DOM runtime", async () => {
    const proc = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, NIFRA_ROUTE_SLOT_CLIENT_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(`${stdout}${stderr}`).toContain("Vue binding loads the target chain")
    if (exitCode !== 0) throw new Error(`${stdout}${stderr}`)
    expect(exitCode).toBe(0)
  }, 30_000)
}
