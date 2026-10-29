import { afterAll, expect, mock, test } from "bun:test"
import { createQueryClient } from "@nifrajs/web"
import * as solidRuntime from "solid-js"

// Bun resolves Solid's server runtime in this suite, where onMount is intentionally a no-op.
// Run the registered mount callback here; the other query tests cover the real owner/provider APIs.
const realSolidRuntime = { ...solidRuntime }
mock.module("solid-js", () => ({
  ...realSolidRuntime,
  onMount: (callback: () => void) => callback(),
}))
afterAll(() => mock.module("solid-js", () => realSolidRuntime))

const { createInfiniteQuery, QueryClientProvider } = await import("../src/query.ts")

test("Solid infinite-query mount callback starts the initial page fetch", async () => {
  const client = createQueryClient({ now: () => 0 })
  let query!: ReturnType<typeof createInfiniteQuery<number, number>>
  let dispose = (): void => {}

  solidRuntime.createRoot((stop) => {
    dispose = stop
    solidRuntime.createComponent(QueryClientProvider, {
      client,
      get children() {
        query = createInfiniteQuery(["solid", "mount-callback"], async (page: number) => page, {
          initialPageParam: 0,
          getNextPageParam: (_last, pages) => (pages.length < 2 ? 1 : undefined),
        })
        return null
      },
    })
  })

  try {
    expect(query.state().status).toBe("pending")
    await query.refetch()
    expect(query.state().data?.pages).toEqual([0])
    expect(query.hasNextPage()).toBe(true)
  } finally {
    dispose()
  }
})
