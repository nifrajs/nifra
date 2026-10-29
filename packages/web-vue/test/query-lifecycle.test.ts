import { afterAll, expect, mock, test } from "bun:test"
import * as vueRuntime from "vue"

// The standard Bun test runtime has no mounted Vue app. Invoke its registered lifecycle callback
// here so this suite covers the adapter's onMounted fetch path without depending on a DOM shim.
const realVueRuntime = { ...vueRuntime }
mock.module("vue", () => ({
  ...realVueRuntime,
  onMounted: (callback: () => void) => callback(),
}))
afterAll(() => mock.module("vue", () => realVueRuntime))

const { useInfiniteQuery } = await import("../src/query.ts")

test("Vue infinite-query mount callback fetches and updates page computeds", async () => {
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true })
  const scope = vueRuntime.effectScope()

  try {
    const query = scope.run(() =>
      useInfiniteQuery(["vue", "mount-callback"], async (page: number) => page, {
        initialPageParam: 0,
        getNextPageParam: (_last, pages) => (pages.length < 2 ? 1 : undefined),
      }),
    )
    if (query === undefined) throw new Error("Vue scope did not run")

    expect(query.isPending.value).toBe(true)
    await query.refetch()
    expect(query.state.value.data?.pages).toEqual([0])
    expect(query.isSuccess.value).toBe(true)
    expect(query.isError.value).toBe(false)
    expect(query.hasNextPage.value).toBe(true)
    expect(query.hasPreviousPage.value).toBe(false)
    await query.fetchNextPage()
    expect(query.hasNextPage.value).toBe(false)
  } finally {
    scope.stop()
    if (beforeWindow) Object.defineProperty(globalThis, "window", beforeWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
