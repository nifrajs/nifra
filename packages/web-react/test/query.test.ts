import { afterEach, expect, test } from "bun:test"
import { createQueryClient, type DehydratedState } from "@nifrajs/web"
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  HydrationBoundary,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "../src/query.ts"

// SSR-only assertions (bun:test has no DOM, so useEffect never fires). We verify: the server snapshot a
// hook reads (idle without a provider, the hydrated data with one), the imperative surface (mutate,
// invalidate, setQueryData — none of which need effects), and that HydrationBoundary seeds during render.
// Fetch-on-mount + re-render-on-transition are browser-verified against the real packages.

// Render a probe through react-dom/server and hand back whatever it captured.
function render<T>(node: ReactNode, capture: () => T): T {
  renderToStaticMarkup(node)
  return capture()
}

afterEach(() => {
  // Nothing global to reset (the query singleton is window-guarded and never created under bun:test).
})

test("useQuery renders idle on the server with no provider", async () => {
  let result: ReturnType<typeof useQuery<string>> | undefined
  const Probe = () => {
    result = useQuery(["k"], async () => "V")
    return null
  }
  render(createElement(Probe), () => result)
  expect(result).toMatchObject({ status: "pending", isPending: true, isSuccess: false })
  expect(typeof result?.refetch).toBe("function")
  // The no-provider (NOOP) handle's refetch is a throwing no-op — a query action with no client.
  await expect(result?.refetch()).rejects.toThrow(/no query client/)
})

test("useQuery reads a hydrated provider client's data during SSR (no loading flash)", () => {
  const client = createQueryClient({ now: () => 0 })
  client.setQueryData(["k"], "SEEDED")
  let result: ReturnType<typeof useQuery<string>> | undefined
  const Probe = () => {
    result = useQuery(["k"], async () => "SEEDED")
    return null
  }
  render(createElement(QueryClientProvider, { client }, createElement(Probe)), () => result)
  expect(result).toMatchObject({
    status: "success",
    data: "SEEDED",
    isSuccess: true,
    isPending: false,
  })
})

test("HydrationBoundary seeds the client during render so children read data on the server", () => {
  const client = createQueryClient({ now: () => 0 })
  const state: DehydratedState = {
    queries: [{ key: ["user", 1], data: { name: "Ada" }, updatedAt: 5 }],
  }
  let result: ReturnType<typeof useQuery<{ name: string }>> | undefined
  const Probe = () => {
    result = useQuery(["user", 1], async () => ({ name: "Ada" }))
    return null
  }
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(HydrationBoundary, { state }, createElement(Probe)),
    ),
    () => result,
  )
  expect(result).toMatchObject({ status: "success", data: { name: "Ada" } })
})

test("useQueryClient returns the provided client; without one, a safe no-op", async () => {
  const client = createQueryClient({ now: () => 0 })
  let got: ReturnType<typeof useQueryClient> | undefined
  const Provided = () => {
    got = useQueryClient()
    return null
  }
  render(createElement(QueryClientProvider, { client }, createElement(Provided)), () => got)
  expect(got).toBe(client)

  let noop: ReturnType<typeof useQueryClient> | undefined
  const NoProvider = () => {
    noop = useQueryClient()
    return null
  }
  render(createElement(NoProvider), () => noop)
  // Every method is a safe no-op on the server (no throw, empty reads).
  expect(noop?.getQueryData(["x"])).toBeUndefined()
  noop?.setQueryData(["x"], 1)
  noop?.invalidateQueries(["x"])
  expect(noop?.dehydrate()).toEqual({ queries: [] })
  noop?.hydrate({ queries: [] })
  await expect(noop?.prefetchQuery(["x"], async () => 1)).resolves.toBeUndefined()
})

test("useMutation: idle on render, mutateAsync runs the fn + resolves; mutate swallows rejection", async () => {
  let ok: ReturnType<typeof useMutation<number, number>> | undefined
  const OkProbe = () => {
    ok = useMutation(async (n: number) => n * 2)
    return null
  }
  render(createElement(OkProbe), () => ok)
  expect(ok).toMatchObject({ status: "idle", isIdle: true, isPending: false })
  expect(await ok?.mutateAsync(21)).toBe(42)

  let bad: ReturnType<typeof useMutation<never, void>> | undefined
  const BadProbe = () => {
    bad = useMutation(async () => {
      throw new Error("nope")
    })
    return null
  }
  render(createElement(BadProbe), () => bad)
  expect(() => bad?.mutate()).not.toThrow() // fire-and-forget swallows the rejection
  await expect(bad?.mutateAsync()).rejects.toThrow("nope")
})

test("without a provider on the client, useQueryClient lazily creates one shared singleton", () => {
  // Simulate a browser (the singleton is `typeof window` guarded). Restore after so the SSR tests keep
  // seeing no window.
  const g = globalThis as { window?: unknown }
  const hadWindow = "window" in g
  g.window = {} as never
  try {
    let a: ReturnType<typeof useQueryClient> | undefined
    let b: ReturnType<typeof useQueryClient> | undefined
    const A = () => {
      a = useQueryClient()
      return null
    }
    const B = () => {
      b = useQueryClient()
      return null
    }
    renderToStaticMarkup(createElement(A))
    renderToStaticMarkup(createElement(B))
    expect(a).toBeDefined()
    expect(a).toBe(b) // same lazily-created singleton across renders
    a?.setQueryData(["n"], 7)
    expect(a?.getQueryData<number>(["n"])).toBe(7) // a real, usable client
  } finally {
    if (!hadWindow) delete g.window
  }
})

test("useInfiniteQuery renders idle on the server with paging controls", () => {
  let result: ReturnType<typeof useInfiniteQuery<string[], number>> | undefined
  const Probe = () => {
    result = useInfiniteQuery(["feed"], async () => [], {
      initialPageParam: 0,
      getNextPageParam: () => undefined,
    })
    return null
  }
  render(createElement(Probe), () => result)
  expect(result).toMatchObject({ status: "pending", isPending: true, hasNextPage: false })
  expect(typeof result?.fetchNextPage).toBe("function")
  expect(typeof result?.fetchPreviousPage).toBe("function")
})
