/** Preact's useQuery: its options reach the page's client; on the server it renders idle. */
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

import { h } from "preact"
import { renderToString } from "preact-render-to-string"
import { type UseQueryResult, useQuery, useQueryClient } from "../src/query.ts"

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
