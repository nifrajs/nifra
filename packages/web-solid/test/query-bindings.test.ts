/** Solid's mutation, paged-query and provider bindings under its browser build. */
import { expect, test } from "bun:test"
import { createQueryClient } from "@nifrajs/web"
import { createComponent, createRoot } from "solid-js"
import { createInfiniteQuery, createMutation, QueryClientProvider } from "../src/query.ts"

const SPAWN_TIMEOUT_MS = 30_000

test(
  "the bindings fetch on mount unless disabled, track their accessors, and survive a failing mutation",
  async () => {
    const script = new URL("./fixtures/query-browser.ts", import.meta.url).pathname
    const proc = Bun.spawn([process.execPath, "--conditions=browser", script], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(stderr).toBe("")
    expect(exit).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.infinite).toEqual({
      afterMount: { fetched: ["on:0"], flags: [false, true, false], offPending: true },
      next: [false, true, false],
      previous: [false, true],
      pages: [0, 0, 1],
      refetched: true,
      previousResolved: true,
    })
    expect(result.failed).toEqual([true, false, false])
    expect(result.mutation).toEqual({
      flags: [
        [true, false, false, false],
        [false, true, false, false],
        [false, false, true, false],
        [false, false, false, true],
      ],
      unhandled: 0,
    })
    expect(result.provider).toEqual({ withoutState: 0, withState: 1, sameClient: true })
    expect(result.idle).toEqual({
      status: "pending",
      next: false,
      previous: false,
      rejected: [true, true, true],
    })
    expect(result.held).toEqual([0])
  },
  SPAWN_TIMEOUT_MS,
)

const options = {
  initialPageParam: 0,
  getNextPageParam: (_last: number, pages: readonly number[]) =>
    pages.length < 2 ? pages.length : undefined,
  getPreviousPageParam: (_first: number, pages: readonly number[]) =>
    pages.length < 2 ? undefined : 0,
}

test("the accessors read the state their handles hold", async () => {
  const client = createQueryClient({ now: () => 0 })
  let query: ReturnType<typeof createInfiniteQuery<number, number>> | undefined
  let failing: ReturnType<typeof createInfiniteQuery<number, number>> | undefined
  let mutation: ReturnType<typeof createMutation<number, number>> | undefined
  let failingMutation: ReturnType<typeof createMutation<number, number>> | undefined
  const dispose = createRoot((stop) => {
    createComponent(QueryClientProvider, {
      client,
      get children() {
        query = createInfiniteQuery(["k"], async (param: number) => param, options)
        failing = createInfiniteQuery(
          ["fails"],
          async () => {
            throw new Error("refused")
          },
          { initialPageParam: 0, getNextPageParam: () => undefined },
        )
        mutation = createMutation(async (value: number) => value * 2)
        failingMutation = createMutation(async () => {
          throw new Error("refused")
        })
        return undefined
      },
    })
    return stop
  })
  expect([query?.isPending(), query?.isSuccess(), query?.isError()]).toEqual([true, false, false])

  await query?.refetch()
  expect([query?.isPending(), query?.isSuccess(), query?.isError()]).toEqual([false, true, false])
  expect([query?.hasNextPage(), query?.hasPreviousPage()]).toEqual([true, false])
  await query?.fetchNextPage()
  expect([query?.hasNextPage(), query?.hasPreviousPage()]).toEqual([false, true])
  await query?.fetchPreviousPage()
  expect(query?.state().data?.pages).toEqual([0, 0, 1])

  await failing?.refetch().catch(() => {})
  expect([failing?.isPending(), failing?.isSuccess(), failing?.isError()]).toEqual([
    false,
    false,
    true,
  ])

  expect([mutation?.isIdle(), mutation?.isPending()]).toEqual([true, false])
  await mutation?.mutateAsync(21)
  expect([mutation?.isSuccess(), mutation?.isError(), mutation?.state().data]).toEqual([
    true,
    false,
    42,
  ])
  failingMutation?.mutate(1)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect([failingMutation?.isError(), failingMutation?.isSuccess()]).toEqual([true, false])
  mutation?.reset()
  expect(mutation?.isIdle()).toBe(true)
  mutation?.cancel()
  dispose()
})
