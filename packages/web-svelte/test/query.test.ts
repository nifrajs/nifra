/** The Svelte query store: its options reach the page's client, and it follows the cache entry. */
import { expect, test } from "bun:test"
import type { QueryOptions } from "@nifrajs/web"
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

import { get } from "svelte/store"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "../src/query.ts"

test("useQuery passes staleTime and live keys through", () => {
  const seen = recordingOptions(() => {
    useQuery(["svelte", "options"], async () => 1, { staleTime: 5, live: ["post:1"] })
  })
  expect(seen).toEqual([{ staleTime: 5, live: ["post:1"] }])
})

test("in a browser the store fetches on its first subscriber and follows the cache entry", async () => {
  let fetches = 0
  const store = asBrowser(() => useQuery(["svelte", "entry"], async () => ++fetches))
  const seen: unknown[] = []
  const stop = asBrowser(() => store.subscribe((state) => seen.push(state.data)))
  expect(fetches).toBe(1)
  await Promise.resolve()
  pageClient().setQueryData(["svelte", "entry"], 7)
  expect(get(store).data).toBe(7)
  expect(seen).toContain(7)
  stop()
})

test("on the server the store stays idle, refetch rejects and the client is a no-op", async () => {
  const store = useQuery(["svelte", "server"], async () => 1)
  expect(get(store).status).toBe("pending")
  await expect(store.refetch()).rejects.toThrow("no query client")
  expect(() => useQueryClient().invalidateQueries(["svelte"])).not.toThrow()
})

test("Svelte mutation store exposes async controls and observable state", async () => {
  const mutation = useMutation(async (value: number) => value * 2)
  const stop = mutation.subscribe(() => {})
  expect(get(mutation).status).toBe("idle")
  await expect(mutation.mutateAsync(21)).resolves.toBe(42)
  expect(get(mutation)).toMatchObject({ status: "success", data: 42, variables: 21 })
  stop()
})

test("Svelte mutation store cancels pending state and callbacks on identity change", async () => {
  await asBrowserAsync(async () => {
    let resolve!: (value: string) => void
    const called: string[] = []
    const mutation = useMutation(() => new Promise<string>((done) => (resolve = done)), {
      onSuccess: () => {
        called.push("success")
      },
    })
    const stop = mutation.subscribe(() => {})
    const pending = mutation.mutateAsync()
    identityChanged()
    await expect(pending).rejects.toThrow("cancelled")
    expect(get(mutation).status).toBe("idle")
    expect(called).toEqual([])
    resolve("private result")
    stop()
  })
})

test("cancelling an unsubscribed Svelte mutation releases its identity listener", async () => {
  await asBrowserAsync(async () => {
    const listeners = (): Set<unknown> | undefined => {
      const value: unknown = Reflect.get(globalThis, Symbol.for("nifra.identity.listeners"))
      return value instanceof Set ? value : undefined
    }
    const before = listeners()?.size ?? 0
    let resolve!: (value: string) => void
    const mutation = useMutation(() => new Promise<string>((done) => (resolve = done)))
    const stop = mutation.subscribe(() => {})
    const pending = mutation.mutateAsync()
    stop()

    expect(listeners()?.size ?? 0).toBe(before + 1)
    mutation.cancel()
    expect(listeners()?.size ?? 0).toBe(before)
    await expect(pending).rejects.toThrow("cancelled")
    resolve("late result")
  })
})

test("Svelte infinite query store pages data and reports whether another page exists", async () => {
  const store = asBrowser(() =>
    useInfiniteQuery(["svelte", "pages"], async (page: number) => page, {
      initialPageParam: 0,
      getNextPageParam: (_last, pages, lastParam) => (pages.length < 2 ? lastParam + 1 : undefined),
    }),
  )
  const stop = asBrowser(() => store.subscribe(() => {}))
  await store.refetch()
  expect(get(store).data?.pages).toEqual([0])
  await store.fetchNextPage()
  expect(get(store).data?.pages).toEqual([0, 1])
  expect(get(store).hasNextPage).toBe(false)
  stop()
})
