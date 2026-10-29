/** Svelte's mutation and paged-query stores, and the provider that scopes a client to a component tree. */
import { expect, test } from "bun:test"
import { createQueryClient } from "@nifrajs/web"
import { get } from "svelte/store"
import { provideQueryClient, useInfiniteQuery, useMutation } from "../src/query.ts"

const asImport = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href)
// Each spawn starts a fresh Bun that compiles Svelte from cold.
const SPAWN_TIMEOUT_MS = 30_000

async function asBrowser<T>(body: () => Promise<T>): Promise<T> {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window")
  Reflect.set(globalThis, "window", globalThis)
  try {
    return await body()
  } finally {
    if (before) Object.defineProperty(globalThis, "window", before)
    else Reflect.deleteProperty(globalThis, "window")
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
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

const options = {
  initialPageParam: 0,
  getNextPageParam: (_last: number, pages: readonly number[]) =>
    pages.length < 2 ? pages.length : undefined,
  getPreviousPageParam: (_first: number, pages: readonly number[]) =>
    pages.length < 2 ? undefined : 0,
}

test("a mutation store shows the state it reached while nothing was subscribed", async () => {
  const mutation = useMutation(async (value: number) => value * 2)
  await mutation.mutateAsync(21)
  expect(get(mutation)).toMatchObject({ status: "success", data: 42 })
})

test("a fire-and-forget mutate that fails raises no unhandled rejection", async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    const mutation = useMutation(async () => {
      throw new Error("refused")
    })
    const stop = mutation.subscribe(() => {})
    mutation.mutate()
    await settled()
    expect(unhandled).toEqual([])
    expect(get(mutation).status).toBe("error")
    stop()
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("a mutation store passes through pending, success and failure", async () => {
  const calls: Array<ReturnType<typeof gate<string>>> = []
  const mutation = useMutation((_value: string) => {
    const call = gate<string>()
    calls.push(call)
    return call.promise
  })
  const statuses: string[] = []
  const stop = mutation.subscribe((state) => statuses.push(state.status))
  mutation.mutate("a")
  calls[0]?.release("done")
  await settled()
  mutation.mutate("b")
  calls[1]?.fail(new Error("refused"))
  await settled()
  stop()
  expect(statuses).toEqual(["idle", "pending", "success", "pending", "error"])
})

test("a paged query store fetches on its first browser subscriber unless disabled", async () => {
  await asBrowser(async () => {
    const fetched: string[] = []
    const page = (name: string) => async (param: number) => {
      fetched.push(`${name}:${param}`)
      return param
    }
    const on = useInfiniteQuery(["svelte", "on"], page("on"), options)
    const off = useInfiniteQuery(["svelte", "off"], page("off"), { ...options, enabled: false })
    const stopOn = on.subscribe(() => {})
    const stopOff = off.subscribe(() => {})
    await settled()
    expect(fetched).toEqual(["on:0"])
    expect(get(on)).toMatchObject({ status: "success", hasNextPage: true, hasPreviousPage: false })
    expect(get(off).status).toBe("pending")

    await on.fetchNextPage()
    expect(get(on)).toMatchObject({ hasNextPage: false, hasPreviousPage: true })
    await expect(on.refetch()).resolves.toBeDefined()
    await expect(on.fetchPreviousPage()).resolves.toBeDefined()
    stopOn()
    stopOff()
  })
})

test("a paged query store shows what the cache gained before anyone subscribed", async () => {
  await asBrowser(async () => {
    const store = useInfiniteQuery(["svelte", "early"], async (param: number) => param, {
      ...options,
      enabled: false,
    })
    await store.refetch()
    expect(get(store)).toMatchObject({ status: "success", hasNextPage: true })
  })
})

test("provideQueryClient seeds the client first and then needs a component to hold it", () => {
  const client = createQueryClient({ now: () => 10 })
  const state = { queries: [{ key: ["svelte", "seed"], data: "seeded", updatedAt: 5 }] }
  expect(() => provideQueryClient(client, state)).toThrow()
  expect(client.getQueryData(["svelte", "seed"])).toBe("seeded")

  const untouched = createQueryClient({ now: () => 10 })
  expect(() => provideQueryClient(untouched)).toThrow()
  expect(untouched.dehydrate({ shouldDehydrateQuery: () => true }).queries).toEqual([])
})

test("on the server a paged query store is idle, has no pages, and its actions reject", async () => {
  const store = useInfiniteQuery(["svelte", "server"], async () => 1, options)
  const stop = store.subscribe(() => {})
  expect(get(store)).toMatchObject({
    status: "pending",
    hasNextPage: false,
    hasPreviousPage: false,
  })
  await expect(store.fetchNextPage()).rejects.toThrow("no query client")
  await expect(store.fetchPreviousPage()).rejects.toThrow("no query client")
  await expect(store.refetch()).rejects.toThrow("no query client")
  stop()
})

test(
  "provideQueryClient scopes a client to its component tree, seeds it when given a snapshot, and fetches nothing on the server",
  async () => {
    const code = `
    import { plugin } from "bun";
    import { createQueryClient } from "@nifrajs/web";
    import { svelteBunPlugin } from ${asImport("../src/plugin.ts")};
    plugin(svelteBunPlugin("ssr"));
    const { render } = await import("svelte/server");
    const Tree = (await import(${asImport("./fixtures/query-tree.svelte")})).default;

    const run = (state) => {
      const client = createQueryClient({ now: () => 10 });
      let hydrated = 0;
      const hydrate = client.hydrate;
      client.hydrate = (snapshot) => { hydrated++; return hydrate(snapshot) };
      let fetched = 0;
      const { body } = render(Tree, { props: { client, state, fetcher: async () => { fetched++; return "network" } } });
      return { html: body.replace(/<!--.*?-->/g, ""), hydrated, fetched, cached: client.getQueryData(["svelte", "request"]) ?? null };
    };

    const seeded = run({ queries: [{ key: ["svelte", "request"], data: "request one", updatedAt: 5 }] });
    const empty = run(undefined);
    const other = run({ queries: [{ key: ["svelte", "request"], data: "request two", updatedAt: 5 }] });
    console.log(JSON.stringify({ seeded, empty, other }));
  `
    const proc = Bun.spawn([process.execPath, "--eval", code], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(stderr).toBe("")
    expect(exit).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.seeded).toEqual({
      html: "<span>request one</span>",
      hydrated: 1,
      fetched: 0,
      cached: "request one",
    })
    expect(result.empty).toEqual({ html: "<span></span>", hydrated: 0, fetched: 0, cached: null })
    expect(result.other).toMatchObject({ html: "<span>request two</span>", cached: "request two" })
  },
  SPAWN_TIMEOUT_MS,
)

void createQueryClient
