import { expect, test } from "bun:test"
import type { RenderProps, RouteSlotName } from "@nifrajs/web"
import { createRouteSlotBinding, type RouteSlotHooks } from "../src/route-slot.tsx"

test("the Solid binding subscribes and synchronizes through the shared route-slot store", () => {
  const props: RenderProps = {
    data: null,
    path: "/dashboard?slot.inspector=%2Fusers%2F7&slot.inspector=%2Fusers%2F8",
  }
  const cleanups: Array<() => void> = []
  const hooks: RouteSlotHooks = {
    createEffect: (effect) => effect(),
    createMemo: (read) => read,
    createSignal<T>(initial: T) {
      let value = initial
      return [
        () => value,
        (next: T | ((previous: T) => T)) => {
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: this fake setter mirrors Solid's updater overload.
          value = typeof next === "function" ? (next as (previous: T) => T)(value) : next
        },
      ]
    },
    onCleanup: (cleanup) => cleanups.push(cleanup),
  }
  const useRouteSlot = createRouteSlotBinding(
    () => props,
    () => {},
    hooks,
  )
  const slot = useRouteSlot("inspector" satisfies RouteSlotName)

  expect(slot.status()).toBe("error")
  expect(slot.error()).toBe("malformed")
  expect(cleanups).toHaveLength(1)
  for (const cleanup of cleanups) cleanup()
})
