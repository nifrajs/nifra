/** Vue's useQuery: its options reach the page's client, and it follows the cache entry. */
import { expect, spyOn, test } from "bun:test"
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

import { effectScope } from "vue"
import { useQuery, useQueryClient } from "../src/query.ts"

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
