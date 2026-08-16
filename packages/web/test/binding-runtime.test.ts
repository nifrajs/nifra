import { afterEach, describe, expect, test } from "bun:test"
import {
  createMountedRouterRef,
  IDLE_FETCHER_STATE,
  idleFetcherSnapshot,
  NO_FETCHERS,
  noFetchers,
} from "../src/internal/fetcher-runtime.ts"
import { getQueryClientSingleton, IDLE_QUERY_STATE } from "../src/internal/query-runtime.ts"
import type { ClientRouter } from "../src/router.ts"

const globalRecord = globalThis as Record<string, unknown>
const hadWindow = "window" in globalRecord

afterEach(() => {
  if (!hadWindow) delete globalRecord.window
})

describe("shared web binding runtime", () => {
  test("all bindings use the same idle query and fetcher shapes", () => {
    expect(IDLE_QUERY_STATE).toEqual({
      status: "pending",
      data: undefined,
      error: undefined,
      isFetching: false,
      updatedAt: Number.NEGATIVE_INFINITY,
    })
    expect(Object.keys(IDLE_QUERY_STATE)).toEqual([
      "status",
      "data",
      "error",
      "isFetching",
      "updatedAt",
    ])
    expect(IDLE_FETCHER_STATE).toEqual({ pending: false, data: undefined })
    expect(idleFetcherSnapshot()).toBe(IDLE_FETCHER_STATE)
    expect(noFetchers()).toBe(NO_FETCHERS)
  })

  test("the browser query singleton is constructed once and reused", () => {
    globalRecord.window = {}
    const first = getQueryClientSingleton()
    const second = getQueryClientSingleton()
    expect(first).toBeDefined()
    expect(second).toBe(first)
  })

  test("mounted-router refs stay isolated between adapter packages", () => {
    const first = createMountedRouterRef()
    const second = createMountedRouterRef()
    const router = {} as ClientRouter

    first.set(router)
    expect(first.get()).toBe(router)
    expect(second.get()).toBeUndefined()

    second.set(router)
    first.set(undefined)
    expect(first.get()).toBeUndefined()
    expect(second.get()).toBe(router)
  })
})
