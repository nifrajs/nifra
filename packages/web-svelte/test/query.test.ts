/** The Svelte query store: its options reach the page's client, and it follows the cache entry. */
import { expect, test } from "bun:test"
import type { QueryOptions } from "@nifrajs/web"
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

import { get } from "svelte/store"
import { useQuery, useQueryClient } from "../src/query.ts"

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
  const stop = store.subscribe((state) => seen.push(state.data))
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
