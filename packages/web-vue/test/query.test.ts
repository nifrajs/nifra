/** Vue's useQuery: its options reach the page's client, and it follows the cache entry. */
import { expect, spyOn, test } from "bun:test"
import {
  createQueryClient,
  type DehydratedState,
  type InfiniteData,
  type QueryOptions,
} from "@nifrajs/web"
import { identityChanged } from "@nifrajs/web/client"
import { getQueryClientSingleton } from "@nifrajs/web/internal/query-runtime"

/** Run `body` with a `window`, as a browser would: the query singleton exists there. */
function asBrowser<T>(body: () => T): T {
  const had = Reflect.has(globalThis, "window")
  if (!had) Reflect.set(globalThis, "window", globalThis)
  try {
    return body()
  } finally {
    if (!had) Reflect.deleteProperty(globalThis, "window")
  }
}

async function asBrowserAsync<T>(body: () => Promise<T>): Promise<T> {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window")
  Reflect.set(globalThis, "window", globalThis)
  try {
    return await body()
  } finally {
    if (before) Object.defineProperty(globalThis, "window", before)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

/** The page's query client, as a browser binding sees it. */
function pageClient() {
  const client = asBrowser(getQueryClientSingleton)
  if (client === undefined) throw new Error("no client-side query client")
  return client
}

/** Run `body` as a browser would, recording the options each query hands the page's client. */
function recordingOptions(body: () => void): (QueryOptions | undefined)[] {
  const client = pageClient()
  const original = client.query
  const seen: (QueryOptions | undefined)[] = []
  client.query = (key, fn, options) => {
    seen.push(options)
    return original(key, fn, options)
  }
  try {
    asBrowser(body)
  } finally {
    client.query = original
  }
  return seen
}

import { createSSRApp, defineComponent, effectScope, h } from "vue"
import { renderToString } from "vue/server-renderer"
import {
  provideQueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "../src/query.ts"

/** Outside a component Vue warns that onMounted has no instance; the subscription is what counts. */
function inScope<T>(body: () => T): { value: T; stop: () => void } {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  const scope = effectScope()
  try {
    const value = scope.run(body)
    if (value === undefined) throw new Error("scope did not run")
    return { value, stop: () => scope.stop() }
  } finally {
    warn.mockRestore()
  }
}

test("useQuery passes staleTime and live keys through", () => {
  let stop = (): void => {}
  const seen = recordingOptions(() => {
    stop = inScope(() =>
      useQuery(["vue", "options"], async () => 1, { staleTime: 5, live: ["post:1"] }),
    ).stop
  })
  stop()
  expect(seen).toEqual([{ staleTime: 5, live: ["post:1"] }])
})

test("in a browser the state ref follows the cache entry until its scope stops", () => {
  const { value: query, stop } = asBrowser(() =>
    inScope(() => useQuery(["vue", "entry"], async () => 1)),
  )
  pageClient().setQueryData(["vue", "entry"], 7)
  expect(query.state.value.data).toBe(7)
  stop()
  pageClient().setQueryData(["vue", "entry"], 8)
  expect(query.state.value.data).toBe(7)
})

test("on the server the state stays idle, refetch rejects and the client is a no-op", async () => {
  const { value: query, stop } = inScope(() => useQuery(["vue", "server"], async () => 1))
  expect(query.state.value.status).toBe("pending")
  await expect(query.refetch()).rejects.toThrow("no query client")
  stop()
  expect(() => useQueryClient().invalidateQueries(["vue"])).not.toThrow()
})

test("infinite queries without a provider expose idle state and reject client actions", async () => {
  const { value: query, stop } = inScope(() =>
    useInfiniteQuery(["vue", "server-pages"], async (page: number) => page, {
      initialPageParam: 0,
      getNextPageParam: () => undefined,
    }),
  )
  expect(query.state.value.status).toBe("pending")
  expect(query.isPending.value).toBe(true)
  expect(query.isError.value).toBe(false)
  expect(query.isSuccess.value).toBe(false)
  expect(query.hasNextPage.value).toBe(false)
  expect(query.hasPreviousPage.value).toBe(false)
  await expect(query.fetchNextPage()).rejects.toThrow("no query client")
  stop()
})

test("provideQueryClient requires component setup", () => {
  expect(() => provideQueryClient(createQueryClient({ now: () => 0 }))).toThrow(
    "must run during component setup",
  )
})

test("Vue mutation state follows the effect scope and async calls resolve", async () => {
  const { value: mutation, stop } = asBrowser(() =>
    inScope(() => useMutation(async (value: number) => value * 2)),
  )
  expect(mutation.isIdle.value).toBe(true)
  const pending = mutation.mutateAsync(21)
  expect(mutation.isPending.value).toBe(true)
  await expect(pending).resolves.toBe(42)
  expect(mutation.isSuccess.value).toBe(true)
  expect(mutation.isError.value).toBe(false)
  expect(mutation.state.value).toMatchObject({ status: "success", data: 42, variables: 21 })
  stop()
})

test("Vue fire-and-forget mutation contains rejected work", async () => {
  const { value: mutation, stop } = inScope(() =>
    useMutation(async () => {
      throw new Error("expected failure")
    }),
  )
  mutation.mutate(1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(mutation.isError.value).toBe(true)
  stop()
})

test("Vue mutation cancellation at an identity boundary discards late results", async () => {
  await asBrowserAsync(async () => {
    let resolve!: (value: string) => void
    const { value: mutation, stop } = inScope(() =>
      useMutation(() => new Promise<string>((done) => (resolve = done))),
    )
    const pending = mutation.mutateAsync()
    identityChanged()
    resolve("private result")
    await expect(pending).rejects.toThrow("cancelled")
    expect(mutation.state.value.status).toBe("idle")
    stop()
  })
})

test("Vue infinite queries expose reactive page controls", async () => {
  const { value: query, stop } = asBrowser(() =>
    inScope(() =>
      useInfiniteQuery(["vue", "pages"], async (page: number) => page, {
        initialPageParam: 0,
        getNextPageParam: (_last, pages, lastParam) =>
          pages.length < 2 ? lastParam + 1 : undefined,
      }),
    ),
  )
  await query.refetch()
  expect(query.state.value.data).toEqual({ pages: [0], pageParams: [0] } satisfies InfiniteData<
    number,
    number
  >)
  await query.fetchNextPage()
  expect(query.state.value.data?.pages).toEqual([0, 1])
  expect(query.hasNextPage.value).toBe(false)
  stop()
})

test("Vue provider hydrates a request-local cache before child setup", async () => {
  const client = createQueryClient({ now: () => 10 })
  const secondRequestClient = createQueryClient({ now: () => 10 })
  const state: DehydratedState = {
    queries: [{ key: ["vue", "request"], data: "request one", updatedAt: 5 }],
  }
  let query: ReturnType<typeof useQuery<string>> | undefined
  const Child = defineComponent({
    setup() {
      query = useQuery(["vue", "request"], async () => "network")
      return () => h("span", query?.state.value.data)
    },
  })
  const App = defineComponent({
    setup() {
      provideQueryClient(client, state)
      return () => h(Child)
    },
  })

  const html = await renderToString(createSSRApp(App))
  expect(html).toContain("request one")
  expect(query?.state.value.data).toBe("request one")
  expect(secondRequestClient.getQueryData(["vue", "request"])).toBeUndefined()
})
