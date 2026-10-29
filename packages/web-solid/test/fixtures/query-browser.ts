/**
 * Solid's query bindings under its browser build, where effects and `onMount` run. Prints one JSON
 * document of what each scenario saw; `query-bindings.test.ts` spawns it with `--conditions=browser`.
 */
import { createQueryClient } from "@nifrajs/web"
import { createComponent, createEffect, createRoot } from "solid-js"
import {
  createInfiniteQuery,
  createMutation,
  QueryClientProvider,
  useQueryClient,
} from "../../src/query.ts"

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const out: Record<string, unknown> = {}
// An effect re-runs on every state change; what matters is how its value moved.
const changes = (values: readonly boolean[]): boolean[] =>
  values.filter((value, index) => index === 0 || value !== values[index - 1])

const options = {
  initialPageParam: 0,
  getNextPageParam: (_last: number, pages: readonly number[]) =>
    pages.length < 2 ? pages.length : undefined,
  getPreviousPageParam: (_first: number, pages: readonly number[]) =>
    pages.length < 2 ? undefined : 0,
}

// A paged query inside a provider: mount fetches unless disabled, accessors follow the data.
{
  const client = createQueryClient({ now: () => 0 })
  const fetched: string[] = []
  const page = (name: string) => async (param: number) => {
    fetched.push(`${name}:${param}`)
    return param
  }
  const nextSeen: boolean[] = []
  const previousSeen: boolean[] = []
  let on: ReturnType<typeof createInfiniteQuery<number, number>> | undefined
  let off: ReturnType<typeof createInfiniteQuery<number, number>> | undefined
  const dispose = createRoot((stop) => {
    createComponent(QueryClientProvider, {
      client,
      get children() {
        on = createInfiniteQuery(["on"], page("on"), options)
        off = createInfiniteQuery(["off"], page("off"), { ...options, enabled: false })
        createEffect(() => void nextSeen.push(on?.hasNextPage() ?? false))
        createEffect(() => void previousSeen.push(on?.hasPreviousPage() ?? false))
        return undefined
      },
    })
    return stop
  })
  await settled()
  const afterMount = {
    fetched: [...fetched],
    flags: [on?.isPending(), on?.isSuccess(), on?.isError()],
    offPending: off?.isPending(),
  }
  await on?.fetchNextPage()
  const previous = await on?.fetchPreviousPage()
  out.infinite = {
    afterMount,
    next: changes(nextSeen),
    previous: changes(previousSeen),
    pages: on?.state().data?.pages,
    refetched: (await on?.refetch()) !== undefined,
    previousResolved: previous !== undefined,
  }
  dispose()
}

// A failing first page.
{
  const client = createQueryClient({ now: () => 0 })
  let failing: ReturnType<typeof createInfiniteQuery<number, number>> | undefined
  const dispose = createRoot((stop) => {
    createComponent(QueryClientProvider, {
      client,
      get children() {
        failing = createInfiniteQuery(
          ["fails"],
          async () => {
            throw new Error("refused")
          },
          { initialPageParam: 0, getNextPageParam: () => undefined },
        )
        return undefined
      },
    })
    return stop
  })
  await settled()
  out.failed = [failing?.isError(), failing?.isSuccess(), failing?.isPending()]
  dispose()
}

// Mutation flags, and a fire-and-forget failure that must not escape as an unhandled rejection.
{
  const unhandled: unknown[] = []
  process.on("unhandledRejection", (reason) => void unhandled.push(reason))
  const releases: Array<(value: string) => void> = []
  const failures: Array<(error: unknown) => void> = []
  const flags: boolean[][] = []
  let m!: ReturnType<typeof createMutation<string, string>>
  const read = (): boolean[] => [m.isIdle(), m.isPending(), m.isSuccess(), m.isError()]
  const dispose = createRoot((stop) => {
    m = createMutation(
      (_value: string) =>
        new Promise<string>((resolve, reject) => {
          releases.push(resolve)
          failures.push(reject)
        }),
    )
    flags.push(read())
    m.mutate("a")
    flags.push(read())
    releases[0]?.("done")
    return stop
  })
  await settled()
  flags.push(read())
  m.mutate("b")
  failures[1]?.(new Error("refused"))
  await settled()
  flags.push(read())
  dispose()
  out.mutation = { flags, unhandled: unhandled.length }
}

// The provider seeds a snapshot only when it is given one.
{
  const client = createQueryClient({ now: () => 0 })
  let hydrated = 0
  const hydrate = client.hydrate
  client.hydrate = (state) => {
    hydrated++
    hydrate(state)
  }
  let seen: unknown
  const dispose = createRoot((stop) => {
    createComponent(QueryClientProvider, {
      client,
      get children() {
        seen = useQueryClient()
        return undefined
      },
    })
    return stop
  })
  const withoutState = hydrated
  const dispose2 = createRoot((stop) => {
    createComponent(QueryClientProvider, {
      client,
      state: { queries: [], infiniteQueries: [] },
      get children() {
        return undefined
      },
    })
    return stop
  })
  out.provider = { withoutState, withState: hydrated, sameClient: seen === client }
  dispose()
  dispose2()
}

// Without a client a paged query is idle, reports no pages, and its actions reject.
{
  let idle: ReturnType<typeof createInfiniteQuery<number, number>> | undefined
  const dispose = createRoot((stop) => {
    idle = createInfiniteQuery(["none"], async (param: number) => param, options)
    return stop
  })
  const rejected = await Promise.all(
    [idle?.fetchNextPage(), idle?.fetchPreviousPage(), idle?.refetch()].map((call) =>
      call?.then(
        () => "resolved",
        (error: Error) => error.message,
      ),
    ),
  )
  out.idle = {
    status: idle?.state().status,
    next: idle?.hasNextPage(),
    previous: idle?.hasPreviousPage(),
    rejected: rejected.map((message) => String(message).includes("no query client")),
  }
  dispose()
}

// A client that already holds pages shows them before anything mounts.
{
  const client = createQueryClient({ now: () => 1 })
  client.hydrate({
    queries: [],
    infiniteQueries: [{ key: ["held"], data: { pages: [0], pageParams: [0] }, updatedAt: 1 }],
  })
  let atCreation: readonly number[] | undefined
  const dispose = createRoot((stop) => {
    createComponent(QueryClientProvider, {
      client,
      get children() {
        const held = createInfiniteQuery(["held"], async (param: number) => param, {
          ...options,
          enabled: false,
        })
        atCreation = held.state().data?.pages
        return undefined
      },
    })
    return stop
  })
  out.held = atCreation
  dispose()
}

console.log(JSON.stringify(out))
process.exit(0)
