/** Vue's mutation, paged-query and provider bindings, mounted for real in a renderer with no DOM. */
import { expect, spyOn, test } from "bun:test"
import { createQueryClient, type DehydratedState } from "@nifrajs/web"
import {
  type Component,
  createRenderer,
  defineComponent,
  type EffectScope,
  effectScope,
  h,
  type VNode,
} from "vue"
import {
  provideQueryClient,
  type UseInfiniteQueryResult,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "../src/query.ts"

/** Run `setup` inside `scope`, as a component would, and hand back what it returned. */
function inScope<T>(scope: EffectScope, setup: () => T): T {
  const result = scope.run(setup)
  if (result === undefined) throw new Error("the effect scope is no longer active")
  return result
}

interface FakeNode {
  readonly children: FakeNode[]
}
const fake = (): FakeNode => ({ children: [] })

/** Vue's own renderer over nodes that are plain objects: components set up and mount, `onMounted` runs. */
const { createApp } = createRenderer<FakeNode, FakeNode>({
  patchProp: () => {},
  insert: (child, parent) => void parent.children.push(child),
  remove: () => {},
  createElement: fake,
  createText: fake,
  createComment: fake,
  setText: () => {},
  setElementText: () => {},
  parentNode: () => null,
  nextSibling: () => null,
})

function mount(component: Component): { readonly unmount: () => void } {
  const app = createApp(component)
  app.mount(fake())
  return { unmount: () => app.unmount() }
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
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))
const empty = (): VNode => h("i")

const options = {
  initialPageParam: 0,
  getNextPageParam: (_last: number, pages: readonly number[]) =>
    pages.length < 2 ? pages.length : undefined,
  getPreviousPageParam: (_first: number, pages: readonly number[]) =>
    pages.length < 2 ? undefined : 0,
}

test("useMutation reports pending, success and failure through its computed flags", async () => {
  const scope = effectScope()
  const calls: Array<ReturnType<typeof gate<string>>> = []
  const mutation = inScope(scope, () =>
    useMutation((_value: string) => {
      const call = gate<string>()
      calls.push(call)
      return call.promise
    }),
  )
  const flags = () => [
    mutation.isIdle.value,
    mutation.isPending.value,
    mutation.isSuccess.value,
    mutation.isError.value,
  ]
  expect(flags()).toEqual([true, false, false, false])

  mutation.mutate("a")
  expect(flags()).toEqual([false, true, false, false])
  calls[0]?.release("done")
  await settled()
  expect(flags()).toEqual([false, false, true, false])

  mutation.mutate("b")
  calls[1]?.fail(new Error("refused"))
  await settled()
  expect(flags()).toEqual([false, false, false, true])
  scope.stop()
})

test("a fire-and-forget mutate that fails raises no unhandled rejection", async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  const scope = effectScope()
  try {
    const mutation = inScope(scope, () =>
      useMutation(async () => {
        throw new Error("refused")
      }),
    )
    mutation.mutate()
    await settled()
    expect(unhandled).toEqual([])
    expect(mutation.isError.value).toBe(true)
  } finally {
    process.off("unhandledRejection", onUnhandled)
    scope.stop()
  }
})

test("a mutation stops following its handle once its scope ends", async () => {
  const scope = effectScope()
  const mutation = inScope(scope, () => useMutation(async (value: number) => value))
  await mutation.mutateAsync(1)
  expect(mutation.state.value.data).toBe(1)
  scope.stop()
  await mutation.mutateAsync(2)
  expect(mutation.state.value.data).toBe(1)
})

test("useInfiniteQuery fetches when its component mounts unless disabled, and follows the cache until unmount", async () => {
  const client = createQueryClient({ now: () => 0 })
  const fetched: string[] = []
  const page = (name: string) => async (param: number) => {
    fetched.push(`${name}:${param}`)
    return param
  }
  let enabled: UseInfiniteQueryResult<number, number> | undefined
  let disabled: UseInfiniteQueryResult<number, number> | undefined
  const Child = defineComponent({
    setup() {
      enabled = useInfiniteQuery(["on"], page("on"), options)
      disabled = useInfiniteQuery(["off"], page("off"), { ...options, enabled: false })
      return empty
    },
  })
  const Root = defineComponent({
    setup() {
      provideQueryClient(client)
      return () => h(Child)
    },
  })
  const app = mount(Root)
  await settled()
  expect(fetched).toEqual(["on:0"])
  expect(enabled?.isSuccess.value).toBe(true)
  expect(enabled?.isPending.value).toBe(false)
  expect(enabled?.isError.value).toBe(false)
  expect(disabled?.isPending.value).toBe(true)
  expect(enabled?.hasNextPage.value).toBe(true)
  expect(enabled?.hasPreviousPage.value).toBe(false)

  await enabled?.fetchNextPage()
  expect(enabled?.state.value.data?.pages).toEqual([0, 1])
  expect(enabled?.hasNextPage.value).toBe(false)
  expect(enabled?.hasPreviousPage.value).toBe(true)
  await expect(enabled?.refetch()).resolves.toBeDefined()
  await expect(enabled?.fetchPreviousPage()).resolves.toBeDefined()

  app.unmount()
  const afterUnmount = enabled?.state.value
  await enabled?.fetchNextPage()
  expect(enabled?.state.value).toBe(afterUnmount)
})

test("useInfiniteQuery reports a failed first page", async () => {
  const client = createQueryClient({ now: () => 0 })
  let result: UseInfiniteQueryResult<number, number> | undefined
  const Child = defineComponent({
    setup() {
      result = useInfiniteQuery(
        ["fails"],
        async () => {
          throw new Error("refused")
        },
        { initialPageParam: 0, getNextPageParam: () => undefined },
      )
      return empty
    },
  })
  mount(
    defineComponent({
      setup() {
        provideQueryClient(client)
        return () => h(Child)
      },
    }),
  )
  await settled()
  expect(result?.isError.value).toBe(true)
  expect(result?.isSuccess.value).toBe(false)
  expect(result?.isPending.value).toBe(false)
})

test("on the server a paged query is idle, has no pages, and its actions reject", async () => {
  const scope = effectScope()
  const query = inScope(scope, () => useInfiniteQuery(["server"], async () => 1, options))
  expect(query.state.value.status).toBe("pending")
  expect(query.hasNextPage.value).toBe(false)
  expect(query.hasPreviousPage.value).toBe(false)
  await expect(query.fetchNextPage()).rejects.toThrow("no query client")
  await expect(query.fetchPreviousPage()).rejects.toThrow("no query client")
  await expect(query.refetch()).rejects.toThrow("no query client")
  scope.stop()
})

test("provideQueryClient seeds a snapshot only when it is given one, and only inside a component", () => {
  const client = createQueryClient({ now: () => 0 })
  const hydrate = spyOn(client, "hydrate")
  const state: DehydratedState = { queries: [], infiniteQueries: [] }
  try {
    mount(
      defineComponent({
        setup() {
          provideQueryClient(client)
          return empty
        },
      }),
    )
    expect(hydrate).not.toHaveBeenCalled()
    mount(
      defineComponent({
        setup() {
          provideQueryClient(client, state)
          return empty
        },
      }),
    )
    expect(hydrate).toHaveBeenCalledTimes(1)
    expect(hydrate).toHaveBeenCalledWith(state)
    expect(() => provideQueryClient(client)).toThrow("must run during component setup")
  } finally {
    hydrate.mockRestore()
  }
})

test("outside a component useQueryClient neither injects nor warns", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    expect(() => useQueryClient().invalidateQueries(["vue"])).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})

test("useInfiniteQuery starts from what the client already holds, and stops following it when its scope ends", async () => {
  const client = createQueryClient({ now: () => 1 })
  client.hydrate({
    queries: [],
    infiniteQueries: [{ key: ["held"], data: { pages: [0], pageParams: [0] }, updatedAt: 1 }],
  })
  let query: UseInfiniteQueryResult<number, number> | undefined
  let atSetup: readonly number[] | undefined
  const Child = defineComponent({
    setup() {
      query = useInfiniteQuery(["held"], async (param: number) => param, {
        ...options,
        enabled: false,
      })
      atSetup = query.state.value.data?.pages
      return empty
    },
  })
  const app = mount(
    defineComponent({
      setup() {
        provideQueryClient(client)
        return () => h(Child)
      },
    }),
  )
  expect(atSetup).toEqual([0])
  await query?.fetchNextPage()
  expect(query?.state.value.data?.pages).toEqual([0, 1])

  app.unmount()
  const heldAtUnmount = query?.state.value
  await query?.fetchPreviousPage()
  expect(query?.state.value).toBe(heldAtUnmount)
})
