/** Preact's mutation and paged-query bindings across renders, mounts and the server. */
import { expect, spyOn, test } from "bun:test"
import { createQueryClient } from "@nifrajs/web"
import { GlobalWindow } from "happy-dom"
import { h, render } from "preact"
import { act } from "preact/test-utils"
import { renderToString } from "preact-render-to-string"
import {
  HydrationBoundary,
  QueryClientProvider,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  useInfiniteQuery,
  useMutation,
} from "../src/query.ts"

/** Mount into a happy-dom document, as a browser page would, and put the globals back. */
async function inBrowser(body: (container: Element) => Promise<void> | void): Promise<void> {
  const browser = new GlobalWindow({ url: "http://query.test/" })
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  Reflect.set(globalThis, "window", browser)
  Reflect.set(globalThis, "document", browser.document)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: happy-dom's element is the DOM surface Preact reads; only its declared type differs.
  const container = browser.document.createElement("div") as unknown as Element
  try {
    await body(container)
  } finally {
    act(() => render(null, container))
    if (beforeWindow) Object.defineProperty(globalThis, "window", beforeWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (beforeDocument) Object.defineProperty(globalThis, "document", beforeDocument)
    else Reflect.deleteProperty(globalThis, "document")
    browser.happyDOM.abort()
  }
}

const gate = <T>() => {
  let release!: (value: T) => void
  let fail!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  return { promise, release, fail }
}

test("useMutation keeps one handle across renders and always calls the latest function and callbacks", async () => {
  await inBrowser(async (container) => {
    let latest: UseMutationResult<number, number> | undefined
    const events: string[] = []
    const Probe = (props: {
      readonly tag: string
      readonly fn: (n: number) => Promise<number>
    }) => {
      latest = useMutation(props.fn, { onSuccess: () => void events.push(props.tag) })
      return null
    }
    act(() => render(h(Probe, { tag: "first", fn: async (n) => n }), container))
    const first = latest
    expect(first?.isIdle).toBe(true)

    await act(async () => {
      await first?.mutateAsync(1)
    })
    expect(latest?.isSuccess).toBe(true)
    expect(latest?.data).toBe(1)

    act(() => render(h(Probe, { tag: "second", fn: async (n) => n * 10 }), container))
    expect(latest?.mutateAsync).toBe(first?.mutateAsync)
    expect(latest?.data).toBe(1)

    await act(async () => {
      await latest?.mutateAsync(2)
    })
    expect(latest?.data).toBe(20)
    expect(events).toEqual(["first", "second"])
  })
})

test("useMutation reports pending, success and failure through its flags", async () => {
  await inBrowser(async (container) => {
    let latest: UseMutationResult<string, string> | undefined
    const calls: Array<ReturnType<typeof gate<string>>> = []
    const Probe = () => {
      latest = useMutation((_value: string) => {
        const call = gate<string>()
        calls.push(call)
        return call.promise
      })
      return null
    }
    act(() => render(h(Probe, null), container))
    const flags = () => [latest?.isIdle, latest?.isPending, latest?.isSuccess, latest?.isError]
    expect(flags()).toEqual([true, false, false, false])

    await act(async () => {
      latest?.mutate("a")
    })
    expect(flags()).toEqual([false, true, false, false])
    expect(latest?.variables).toBe("a")

    await act(async () => {
      calls[0]?.release("done")
      await calls[0]?.promise
    })
    expect(flags()).toEqual([false, false, true, false])

    await act(async () => {
      latest?.mutate("b")
    })
    await act(async () => {
      calls[1]?.fail(new Error("refused"))
      await calls[1]?.promise.catch(() => {})
    })
    expect(flags()).toEqual([false, false, false, true])
    expect(latest?.error).toMatchObject({ message: "refused" })
  })
})

test("a fire-and-forget mutate that fails raises no unhandled rejection", async () => {
  await inBrowser(async (container) => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    let latest: UseMutationResult<void, void> | undefined
    const Probe = () => {
      latest = useMutation(async () => {
        throw new Error("refused")
      })
      return null
    }
    try {
      act(() => render(h(Probe, null), container))
      await act(async () => {
        latest?.mutate()
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      expect(unhandled).toEqual([])
      expect(latest?.isError).toBe(true)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})

test("useInfiniteQuery fetches on mount unless disabled, and reports its state through flags", async () => {
  await inBrowser(async (container) => {
    const client = createQueryClient({ now: () => 0 })
    const fetched: string[] = []
    let enabledResult: UseInfiniteQueryResult<number, number> | undefined
    let disabledResult: UseInfiniteQueryResult<number, number> | undefined
    const page = (name: string) => async (param: number) => {
      fetched.push(`${name}:${param}`)
      return param
    }
    const options = {
      initialPageParam: 0,
      getNextPageParam: (_last: number, pages: readonly number[]) =>
        pages.length < 2 ? pages.length : undefined,
      getPreviousPageParam: () => undefined,
    }
    const Probe = () => {
      enabledResult = useInfiniteQuery(["on"], page("on"), options)
      disabledResult = useInfiniteQuery(["off"], page("off"), { ...options, enabled: false })
      return null
    }
    await act(async () => {
      render(h(QueryClientProvider, { client }, h(Probe, null)), container)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(fetched).toEqual(["on:0"])
    expect(enabledResult?.isSuccess).toBe(true)
    expect(enabledResult?.isPending).toBe(false)
    expect(enabledResult?.isError).toBe(false)
    expect(enabledResult?.hasNextPage).toBe(true)
    expect(enabledResult?.hasPreviousPage).toBe(false)
    expect(disabledResult?.isPending).toBe(true)

    await act(async () => {
      await enabledResult?.fetchNextPage()
    })
    expect(enabledResult?.data?.pages).toEqual([0, 1])
    expect(enabledResult?.hasNextPage).toBe(false)
    await act(async () => {
      await enabledResult?.refetch()
    })
    expect(fetched.filter((entry) => entry.startsWith("on:"))).toContain("on:0")
    await act(async () => {
      await expect(enabledResult?.fetchPreviousPage()).resolves.toBeDefined()
    })
  })
})

test("useInfiniteQuery reports a failed first page", async () => {
  await inBrowser(async (container) => {
    const client = createQueryClient({ now: () => 0 })
    let result: UseInfiniteQueryResult<number, number> | undefined
    const Probe = () => {
      result = useInfiniteQuery(
        ["fails"],
        async () => {
          throw new Error("refused")
        },
        { initialPageParam: 0, getNextPageParam: () => undefined },
      )
      return null
    }
    await act(async () => {
      render(h(QueryClientProvider, { client }, h(Probe, null)), container)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(result?.isError).toBe(true)
    expect(result?.isSuccess).toBe(false)
    expect(result?.isPending).toBe(false)
  })
})

test("on the server a paged query is idle, has no pages, and its actions reject", async () => {
  let result: UseInfiniteQueryResult<number, number> | undefined
  const Probe = () => {
    result = useInfiniteQuery(["server"], async () => 1, {
      initialPageParam: 0,
      getNextPageParam: () => 1,
    })
    return null
  }
  renderToString(h(Probe, null))
  expect(result?.isPending).toBe(true)
  expect(result?.hasNextPage).toBe(false)
  expect(result?.hasPreviousPage).toBe(false)
  await expect(result?.fetchNextPage()).rejects.toThrow("no query client")
  await expect(result?.fetchPreviousPage()).rejects.toThrow("no query client")
  await expect(result?.refetch()).rejects.toThrow("no query client")
})

test("HydrationBoundary with no state hydrates nothing", () => {
  const client = createQueryClient({ now: () => 0 })
  const hydrate = spyOn(client, "hydrate")
  try {
    const html = renderToString(
      h(QueryClientProvider, { client }, h(HydrationBoundary, { state: undefined }, "child")),
    )
    expect(html).toBe("child")
    expect(hydrate).not.toHaveBeenCalled()
  } finally {
    hydrate.mockRestore()
  }
})
