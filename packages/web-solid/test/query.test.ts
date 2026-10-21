/** Solid's createQuery: its options reach the page's client, and it follows the cache entry. */
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

import { createRoot } from "solid-js"
import { createQuery, useQueryClient } from "../src/query.ts"

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
  await createRoot(async (dispose) => {
    const query = createQuery(["solid", "server"], async () => 1)
    expect(query.state().status).toBe("pending")
    await expect(query.refetch()).rejects.toThrow("no query client")
    dispose()
  })
  expect(() => useQueryClient().invalidateQueries(["solid"])).not.toThrow()
})
