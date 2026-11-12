import { expect, test } from "bun:test"
import { createRenderer, defineComponent, h } from "vue"
import { type UseInfiniteQueryResult, useInfiniteQuery } from "../src/query.ts"

// A renderer with no host objects mounts a real component, so Vue runs its `onMounted` hooks without
// a DOM shim or a module mock (a mocked "vue" outlives its file and changes `onMounted` for every
// file that runs after it).
const { render } = createRenderer<object, object>({
  patchProp: () => {},
  insert: () => {},
  remove: () => {},
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText: () => {},
  setElementText: () => {},
  parentNode: () => null,
  nextSibling: () => null,
})

test("Vue infinite-query mount callback fetches and updates page computeds", async () => {
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true })
  const root = {}
  let query: UseInfiniteQueryResult<number, number> | undefined
  const Page = defineComponent({
    setup() {
      query = useInfiniteQuery(["vue", "mount-callback"], async (page: number) => page, {
        initialPageParam: 0,
        getNextPageParam: (_last, pages) => (pages.length < 2 ? 1 : undefined),
      })
      return () => h("div")
    },
  })

  try {
    render(h(Page), root)
    if (query === undefined) throw new Error("Vue did not run the component's setup")

    expect(query.isPending.value).toBe(true)
    await query.refetch()
    expect(query.state.value.data?.pages).toEqual([0])
    expect(query.isSuccess.value).toBe(true)
    expect(query.isError.value).toBe(false)
    expect(query.hasNextPage.value).toBe(true)
    expect(query.hasPreviousPage.value).toBe(false)
    await query.fetchNextPage()
    expect(query.hasNextPage.value).toBe(false)
  } finally {
    render(null, root)
    if (beforeWindow) Object.defineProperty(globalThis, "window", beforeWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
