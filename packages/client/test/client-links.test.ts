import { describe, expect, test } from "bun:test"
import type { FetchFn } from "@nifrajs/client"
import { type ClientOptions, client } from "@nifrajs/client"

const mk = (opts: ClientOptions): RawClient => client("http://t", opts) as unknown as RawClient

interface RawRoute {
  get(o?: unknown): Promise<{ ok: boolean; status: number; data: unknown; error: unknown }>
  post(b?: unknown, o?: unknown): Promise<{ ok: boolean; status: number; error: unknown }>
}
interface RawClient {
  readonly thing: RawRoute
}

/** A fetch stub returning a scripted sequence of statuses (or throwing "network" for status 0). */
function scriptedFetch(statuses: number[]): { fetch: FetchFn; calls: number } {
  const state = { calls: 0 }
  const fetch: FetchFn = async () => {
    const status = statuses[Math.min(state.calls, statuses.length - 1)] ?? 200
    state.calls += 1
    if (status === 0) throw new Error("network down")
    return new Response(JSON.stringify({ n: state.calls }), {
      status,
      headers: { "content-type": "application/json" },
    })
  }
  return {
    fetch,
    get calls() {
      return state.calls
    },
  }
}

describe("client links: onRequest / onResponse", () => {
  test("onRequest merges returned headers (async token injection)", async () => {
    let seen: string | undefined
    const fetch: FetchFn = async (_url, init) => {
      seen = (init?.headers as Record<string, string>)?.authorization
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }
    const api = mk({
      fetch,
      onRequest: async () => ({ authorization: "Bearer fresh" }),
    })
    await api.thing.get()
    expect(seen).toBe("Bearer fresh")
  })

  test("onResponse observes the final response", async () => {
    const statuses: number[] = []
    const api = mk({
      fetch: async () =>
        new Response("{}", { status: 201, headers: { "content-type": "application/json" } }),
      onResponse: ({ response }) => {
        statuses.push(response.status)
      },
    })
    await api.thing.get()
    expect(statuses).toEqual([201])
  })
})

describe("client links: retry (safe by default)", () => {
  test("retries a transient 503 on an idempotent GET, then succeeds", async () => {
    const scripted = scriptedFetch([503, 503, 200])
    const api = mk({
      fetch: scripted.fetch,
      retry: { attempts: 3, backoff: () => 0 },
    })
    const res = await api.thing.get()
    expect(res.ok).toBe(true)
    expect(scripted.calls).toBe(3)
  })

  test("never retries a non-idempotent POST by default", async () => {
    const scripted = scriptedFetch([503, 200])
    const api = mk({
      fetch: scripted.fetch,
      retry: { attempts: 3, backoff: () => 0 },
    })
    const res = await api.thing.post({ x: 1 })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(503)
    expect(scripted.calls).toBe(1) // no retry
  })

  test("never retries a 4xx (or 429) even on an idempotent method", async () => {
    const scripted = scriptedFetch([429, 200])
    const api = mk({
      fetch: scripted.fetch,
      retry: { attempts: 3, backoff: () => 0 },
    })
    const res = await api.thing.get()
    expect(res.status).toBe(429)
    expect(scripted.calls).toBe(1)
  })

  test("retries a network error and gives up after the attempt budget", async () => {
    const scripted = scriptedFetch([0, 0, 0])
    const api = mk({
      fetch: scripted.fetch,
      retry: { attempts: 2, backoff: () => 0 },
    })
    const res = await api.thing.get()
    expect(res).toMatchObject({ ok: false, status: 0, error: { error: "network_error" } })
    expect(scripted.calls).toBe(3) // first + 2 retries
  })

  test("no retry config → one attempt", async () => {
    const scripted = scriptedFetch([503])
    const api = client("http://t", { fetch: scripted.fetch }) as unknown as RawClient
    await api.thing.get()
    expect(scripted.calls).toBe(1)
  })

  test("a custom retryable status can be opted in", async () => {
    const scripted = scriptedFetch([500, 200])
    const api = mk({
      fetch: scripted.fetch,
      retry: { attempts: 1, on: [500], backoff: () => 0 },
    })
    const res = await api.thing.get()
    expect(res.ok).toBe(true)
    expect(scripted.calls).toBe(2)
  })
})

describe("client links: timeout", () => {
  test("a slow request aborts as a timeout Result, not a throw", async () => {
    const slowFetch: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        )
      })
    const api = client("http://t", { fetch: slowFetch, timeoutMs: 20 }) as unknown as RawClient
    const res = await api.thing.get()
    expect(res).toMatchObject({ ok: false, status: 0, error: { error: "timeout" } })
  })
})
