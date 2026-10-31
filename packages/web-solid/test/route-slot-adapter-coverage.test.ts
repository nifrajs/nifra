import { expect, mock, test } from "bun:test"
import type { RenderProps, RouteSlotName } from "@nifrajs/web"
import { GlobalWindow } from "happy-dom"

declare module "@nifrajs/web" {
  interface RouteTable {
    "/dashboard": { readonly slots: { readonly inspector: readonly ["/users/:id"] } }
    "/users/:id": object
  }
}

test("the Solid binding subscribes and synchronizes through the shared route-slot store", async () => {
  const browser = new GlobalWindow({ url: "https://route-slot.test/dashboard" })
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const props: RenderProps = {
    data: null,
    path: "/dashboard?slot.inspector=%2Fusers%2F7&slot.inspector=%2Fusers%2F8",
  }
  const cleanups: Array<() => void> = []
  const solid = {
    createComponent: (
      component: (props: Record<string, unknown>) => unknown,
      value: Record<string, unknown>,
    ) => component(value),
    createEffect: (effect: () => void) => effect(),
    createMemo: (read: () => unknown) => read,
    createSignal<T>(initial: T) {
      let value = initial
      return [
        () => value,
        (next: T | ((previous: T) => T)) => {
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The function branch is the updater form accepted by Solid's signal setter in this test double.
          value = typeof next === "function" ? (next as (previous: T) => T)(value) : next
        },
      ] as const
    },
    onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
    untrack: <T>(read: () => T): T => read(),
    useContext: (_context: unknown) => props,
  }
  mock.module("solid-js", () => solid)
  mock.module("solid-js/web", () => ({ Dynamic: () => null }))
  mock.module(import.meta.resolve("../src/router.ts"), () => ({
    RenderPropsContext: {},
    SearchContext: {},
    useNavigate: () => (_target: unknown) => {},
  }))
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: browser,
  })

  try {
    const { RouteSlot } = await import("../src/route-slot.tsx")
    const result = RouteSlot({
      name: "inspector" satisfies RouteSlotName,
      error: (code) => `Error: ${code}`,
    })
    expect(typeof result === "function" ? result() : result).toBe("Error: malformed")
    expect(cleanups).toHaveLength(1)
  } finally {
    for (const cleanup of cleanups) cleanup()
    if (beforeWindow === undefined) Reflect.deleteProperty(globalThis, "window")
    else Object.defineProperty(globalThis, "window", beforeWindow)
    await browser.happyDOM.close()
    mock.restore()
  }
})
