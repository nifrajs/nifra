/** Preact's useQuery: its options reach the page's client; on the server it renders idle. */
import { expect, spyOn, test } from "bun:test"
import { createQueryClient, type DehydratedState, type QueryOptions } from "@nifrajs/web"
import { getQueryClientSingleton } from "@nifrajs/web/internal/query-runtime"
import { GlobalWindow } from "happy-dom"

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

import { h, render } from "preact"
import { act } from "preact/test-utils"
import { renderToString } from "preact-render-to-string"
import {
  HydrationBoundary,
  QueryClientProvider,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "../src/query.ts"

test("useQuery passes staleTime and live keys through", () => {
  const Probe = () => {
    useQuery(["preact", "options"], async () => 1, { staleTime: 5, live: ["post:1"] })
    return null
  }
  const seen = recordingOptions(() => {
    renderToString(h(Probe, null))
  })
  expect(seen).toEqual([{ staleTime: 5, live: ["post:1"] }])
})

test("on the server useQuery renders idle, refetch rejects and the client is a no-op", async () => {
  let result: UseQueryResult<number> | undefined
  const Probe = () => {
    result = useQuery(["preact", "server"], async () => 1)
    return null
  }
  renderToString(h(Probe, null))
  expect(result?.isPending).toBe(true)
  await expect(result?.refetch()).rejects.toThrow("no query client")
  expect(() => useQueryClient().invalidateQueries(["preact"])).not.toThrow()
})

test("infinite queries without a provider use idle state and reject client actions on the server", async () => {
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true })
  let result: UseInfiniteQueryResult<number, number> | undefined
  const Probe = () => {
    result = useInfiniteQuery(["preact", "server-pages"], async (page) => page, {
      initialPageParam: 0,
      getNextPageParam: () => undefined,
    })
    return null
  }
  try {
    renderToString(h(Probe, null))
    expect(result?.isPending).toBe(true)
    expect(result?.hasPreviousPage).toBe(false)
    await expect(result?.refetch()).rejects.toThrow("no query client")
  } finally {
    if (beforeWindow) Object.defineProperty(globalThis, "window", beforeWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})

test("infinite query reads hydrated pages through a request-scoped provider", () => {
  const client = createQueryClient({ now: () => 2 })
  const state: DehydratedState = {
    queries: [],
    infiniteQueries: [
      {
        key: ["preact", "pages"],
        data: { pages: ["first"], pageParams: [0] },
        updatedAt: 1,
      },
    ],
  }
  let result: UseInfiniteQueryResult<string, number> | undefined
  const Probe = () => {
    result = useInfiniteQuery(["preact", "pages"], async (page) => String(page), {
      initialPageParam: 0,
      getNextPageParam: (_last, pages) => (pages.length < 2 ? 1 : undefined),
    })
    return null
  }
  renderToString(
    h(QueryClientProvider, { client }, h(HydrationBoundary, { state }, h(Probe, null))),
  )
  expect(result?.data?.pages).toEqual(["first"])
  expect(result?.hasNextPage).toBe(true)
})

test("HydrationBoundary hydrates only when its client or state reference changes", () => {
  const browser = new GlobalWindow({ url: "http://query.test/" })
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  Reflect.set(globalThis, "window", browser)
  Reflect.set(globalThis, "document", browser.document)

  const client = createQueryClient({ now: () => 0 })
  const otherClient = createQueryClient({ now: () => 0 })
  const hydrate = spyOn(client, "hydrate")
  const otherHydrate = spyOn(otherClient, "hydrate")
  const state: DehydratedState = { queries: [], infiniteQueries: [] }
  const nextState: DehydratedState = { queries: [], infiniteQueries: [] }
  const container = browser.document.createElement("div")
  const tree = (activeClient: typeof client, activeState: DehydratedState) =>
    h(
      QueryClientProvider,
      { client: activeClient },
      h(HydrationBoundary, { state: activeState }, h("span", null, "child")),
    )

  try {
    act(() => render(tree(client, state), container))
    act(() => render(tree(client, state), container))
    expect(hydrate).toHaveBeenCalledTimes(1)

    act(() => render(tree(client, nextState), container))
    expect(hydrate).toHaveBeenCalledTimes(2)

    act(() => render(tree(otherClient, nextState), container))
    expect(otherHydrate).toHaveBeenCalledTimes(1)
  } finally {
    act(() => render(null, container))
    hydrate.mockRestore()
    otherHydrate.mockRestore()
    if (beforeWindow) Object.defineProperty(globalThis, "window", beforeWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (beforeDocument) Object.defineProperty(globalThis, "document", beforeDocument)
    else Reflect.deleteProperty(globalThis, "document")
    browser.happyDOM.abort()
  }
})

test("infinite queries fetch on mount and expose previous-page state", async () => {
  const browser = new GlobalWindow({ url: "http://query.test/" })
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  Reflect.set(globalThis, "window", browser)
  Reflect.set(globalThis, "document", browser.document)

  const client = createQueryClient({ now: () => 0 })
  let result: UseInfiniteQueryResult<number, number> | undefined
  const Probe = () => {
    result = useInfiniteQuery(["preact", "mounted-pages"], async (page) => page, {
      initialPageParam: 0,
      getNextPageParam: (_last, pages) => (pages.length < 2 ? 1 : undefined),
    })
    return null
  }
  const container = browser.document.createElement("div")

  try {
    act(() => render(h(QueryClientProvider, { client }, h(Probe, null)), container))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result?.data?.pages).toEqual([0])
    expect(result?.hasNextPage).toBe(true)
    expect(result?.hasPreviousPage).toBe(false)
  } finally {
    act(() => render(null, container))
    if (beforeWindow) Object.defineProperty(globalThis, "window", beforeWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (beforeDocument) Object.defineProperty(globalThis, "document", beforeDocument)
    else Reflect.deleteProperty(globalThis, "document")
    browser.happyDOM.abort()
  }
})

test("mutation binding exposes promise and fire-and-forget forms", async () => {
  let result: UseMutationResult<number, number> | undefined
  const Probe = () => {
    result = useMutation(async (value: number) => value * 2)
    return null
  }
  renderToString(h(Probe, null))
  expect(result?.isIdle).toBe(true)
  await expect(result?.mutateAsync(21)).resolves.toBe(42)
  expect(() => result?.mutate(1)).not.toThrow()

  let failed: UseMutationResult<number, number> | undefined
  const FailureProbe = () => {
    failed = useMutation(async () => {
      throw new Error("expected failure")
    })
    return null
  }
  renderToString(h(FailureProbe, null))
  failed?.mutate(1)
  await new Promise((resolve) => setTimeout(resolve, 0))
})
