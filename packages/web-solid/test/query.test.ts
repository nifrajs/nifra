/** Solid's createQuery: its options reach the page's client, and it follows the cache entry. */
import { expect, test } from "bun:test"
import { createQueryClient, type DehydratedState, type QueryOptions } from "@nifrajs/web"
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

import { createComponent, createRoot } from "solid-js"
import {
  createInfiniteQuery,
  createMutation,
  createQuery,
  QueryClientProvider,
  useQueryClient,
} from "../src/query.ts"

test("createQuery passes staleTime and live keys through", () => {
  const seen = recordingOptions(() => {
    createRoot((dispose) => {
      createQuery(["solid", "options"], async () => 1, { staleTime: 5, live: ["post:1"] })
      dispose()
    })
  })
  expect(seen).toEqual([{ staleTime: 5, live: ["post:1"] }])
})

test("in a browser the accessor follows the cache entry until its owner is disposed", () => {
  createRoot((dispose) => {
    const query = asBrowser(() => createQuery(["solid", "entry"], async () => 1))
    pageClient().setQueryData(["solid", "entry"], 7)
    expect(query.state().data).toBe(7)
    dispose()
  })
})

test("on the server the accessor stays idle, refetch rejects and the client is a no-op", async () => {
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true })
  try {
    await createRoot(async (dispose) => {
      const query = createQuery(["solid", "server"], async () => 1)
      expect(query.state().status).toBe("pending")
      await expect(query.refetch()).rejects.toThrow("no query client")

      const infinite = createInfiniteQuery(
        ["solid", "server-pages"],
        async (page: number) => page,
        {
          initialPageParam: 0,
          getNextPageParam: () => undefined,
        },
      )
      expect(infinite.state().status).toBe("pending")
      expect(infinite.isPending()).toBe(true)
      expect(infinite.isError()).toBe(false)
      expect(infinite.isSuccess()).toBe(false)
      expect(infinite.hasNextPage()).toBe(false)
      expect(infinite.hasPreviousPage()).toBe(false)
      await expect(infinite.fetchNextPage()).rejects.toThrow("no query client")
      dispose()
    })
    expect(() => useQueryClient().invalidateQueries(["solid"])).not.toThrow()
  } finally {
    if (beforeWindow) Object.defineProperty(globalThis, "window", beforeWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})

test("Solid mutation state uses accessors and cancels old identity work", async () => {
  let mutation!: ReturnType<typeof createMutation<number, number>>
  let dispose!: () => void
  createRoot((stop) => {
    dispose = stop
    mutation = createMutation(async (value: number) => value * 2)
  })
  expect(mutation.isIdle()).toBe(true)
  const pending = mutation.mutateAsync(21)
  expect(mutation.isPending()).toBe(true)
  await expect(pending).resolves.toBe(42)
  expect(mutation.isSuccess()).toBe(true)
  expect(mutation.isError()).toBe(false)
  expect(mutation.state()).toMatchObject({ status: "success", data: 42, variables: 21 })
  dispose()

  let failed!: ReturnType<typeof createMutation<number, number>>
  let disposeFailed = (): void => {}
  createRoot((stop) => {
    disposeFailed = stop
    failed = createMutation(async () => {
      throw new Error("expected failure")
    })
  })
  try {
    failed.mutate(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(failed.isError()).toBe(true)
  } finally {
    disposeFailed()
  }

  const before = Object.getOwnPropertyDescriptor(globalThis, "window")
  Reflect.set(globalThis, "window", globalThis)
  try {
    let resolve!: (value: number) => void
    let cancelledMutation!: ReturnType<typeof createMutation<number, void>>
    createRoot((stop) => {
      dispose = stop
      cancelledMutation = createMutation<number, void>(
        () => new Promise<number>((done) => (resolve = done)),
      )
    })
    const pending = cancelledMutation.mutateAsync(undefined)
    identityChanged()
    resolve(7)
    await expect(pending).rejects.toThrow("cancelled")
    expect(cancelledMutation.state().status).toBe("idle")
    dispose()
  } finally {
    if (before) Object.defineProperty(globalThis, "window", before)
    else Reflect.deleteProperty(globalThis, "window")
  }
})

test("on the server an infinite query stays idle and its actions reject", async () => {
  await createRoot(async (dispose) => {
    const query = createInfiniteQuery(["solid", "server-pages"], async (page: number) => page, {
      initialPageParam: 0,
      getNextPageParam: () => undefined,
    })
    expect(query.state().status).toBe("pending")
    expect(query.hasNextPage()).toBe(false)
    expect(query.hasPreviousPage()).toBe(false)
    await expect(query.fetchNextPage()).rejects.toThrow("no query client")
    dispose()
  })
})

test("Solid infinite query exposes reactive pagination controls", async () => {
  let query!: ReturnType<typeof createInfiniteQuery<number, number>>
  let dispose!: () => void
  createRoot((stop) => {
    dispose = stop
    query = asBrowser(() =>
      createInfiniteQuery(["solid", "pages"], async (page: number) => page, {
        initialPageParam: 0,
        getNextPageParam: (_last, pages, lastParam) =>
          pages.length < 2 ? lastParam + 1 : undefined,
      }),
    )
  })
  expect(query.isPending()).toBe(true)
  expect(query.isError()).toBe(false)
  await query.refetch()
  expect(query.state().data?.pages).toEqual([0])
  expect(query.isSuccess()).toBe(true)
  expect(query.hasPreviousPage()).toBe(false)
  await query.fetchNextPage()
  expect(query.state().data?.pages).toEqual([0, 1])
  expect(query.hasNextPage()).toBe(false)
  dispose()
})

test("Solid provider hydrates its request-local cache before child setup", () => {
  const key = ["solid", "request"]
  const client = createQueryClient({ now: () => 10 })
  const secondRequestClient = createQueryClient({ now: () => 10 })
  const state: DehydratedState = {
    queries: [{ key, data: "request one", updatedAt: 5 }],
  }
  let query!: ReturnType<typeof createQuery<string>>
  const Probe = () => {
    query = createQuery(key, async () => "network")
    return null
  }
  createRoot((dispose) => {
    createComponent(QueryClientProvider, {
      client,
      state,
      get children() {
        return createComponent(Probe, {})
      },
    })
    expect(query.state().data).toBe("request one")
    dispose()
  })
  expect(secondRequestClient.getQueryData(key)).toBeUndefined()
})
