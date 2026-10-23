/**
 * Structural sharing on revalidation: a reload of a path already on screen keeps the identity of every
 * part it did not change, wherever the reload comes from, and an unchanged response text skips the
 * parse.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  type BoundaryStates,
  createClientRouter,
  type FetchRouteData,
  type RouterState,
} from "../src/index.ts"

const patterns = [
  { routeId: "list", pattern: "/list" },
  { routeId: "user", pattern: "/users/:id" },
  { routeId: "photo", pattern: "/photos/:id" },
]

type Row = { id: number; label: string }
const listData = (labels: Record<number, string> = {}) => ({
  title: "List",
  items: Array.from({ length: 5 }, (_, id): Row => ({ id, label: labels[id] ?? `row ${id}` })),
})
const boundaries: BoundaryStates = {
  photo: { name: "photo", mode: { intercept: "/photos/:id" }, status: "unresolved" },
}
// The envelope a server sends for `/list`, a new copy on every request.
const listEnvelope = (labels?: Record<number, string>) => ({
  v: 1,
  data: listData(labels),
  layoutData: [{ nav: ["home", "list"] }],
  boundaries,
})
const onList = (data: unknown = listData()): RouterState => ({
  routeId: "list",
  params: {},
  path: "/list",
  data,
  layoutData: [{ nav: ["home", "list"] }],
  boundaries,
  pending: false,
})

// The rows a published list page shows.
const rowsOf = (state: RouterState): unknown[] => {
  const items: unknown = Reflect.get(Object(state.data), "items")
  if (!Array.isArray(items)) throw new Error("[test] the page shows no list")
  return items
}

// The keys whose values changed identity between two published states.
const changedKeys = (before: RouterState, after: RouterState): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => !Object.is(Reflect.get(before, key), Reflect.get(after, key)),
  )

// Answers every action POST (and any other `fetch`) with `response()`.
const answer = (response: () => Response) =>
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => response(), fetch))

afterEach(() => mock.restore())

describe("a reload shares what it did not change", () => {
  test("an unchanged invalidate publishes only the pending flag", async () => {
    const fetchData: FetchRouteData = async () => JSON.parse(JSON.stringify(listEnvelope()))
    const r = createClientRouter({ patterns, initial: onList(), fetchData })
    await r.invalidate()
    const before = r.snapshot()
    const published: RouterState[] = []
    r.subscribe(() => published.push(r.snapshot()))
    await r.invalidate()
    expect(published.map((state) => changedKeys(before, state))).toEqual([["pending"], []])
    expect(published.at(-1)?.pending).toBe(false)
  })

  test("one changed row is new; every other row, the layout data and the boundaries keep identity", async () => {
    let labels: Record<number, string> = {}
    const r = createClientRouter({
      patterns,
      initial: onList(),
      fetchData: async () => listEnvelope(labels),
    })
    const before = r.snapshot()
    labels = { 2: "changed" }
    await r.invalidate()
    const after = r.snapshot()
    expect(rowsOf(after)[2]).toEqual({ id: 2, label: "changed" })
    for (const i of [0, 1, 3, 4]) expect(rowsOf(after)[i]).toBe(rowsOf(before)[i])
    expect(after.layoutData).toBe(before.layoutData)
    expect(after.boundaries).toBe(before.boundaries)
  })

  test("an action's revalidation keeps unchanged rows", async () => {
    answer(() => Response.json({ ok: true }))
    const r = createClientRouter({
      patterns,
      initial: onList(),
      fetchData: async () => listEnvelope({ 4: "added" }),
    })
    const before = r.snapshot()
    await r.submit("/list", new URLSearchParams({ label: "added" }))
    const after = r.snapshot()
    expect(after.actionData).toEqual({ ok: true })
    expect(rowsOf(after)[0]).toBe(rowsOf(before)[0])
    expect(rowsOf(after)[4]).not.toBe(rowsOf(before)[4])
  })

  test("X-Nifra-Revalidate shares the page's reload and a fetcher's", async () => {
    answer(() =>
      Response.json({ ok: true }, { headers: { "x-nifra-revalidate": "/list,/users/7" } }),
    )
    const r = createClientRouter({
      patterns,
      initial: onList(),
      fetchData: async (path) => (path === "/list" ? listEnvelope() : { user: { id: 7 } }),
    })
    const viewer = r.fetcher("viewer")
    await viewer.load("/users/7")
    const page = r.snapshot().data
    const shown = viewer.snapshot().data
    await r.fetcher("row").submit("/list", new URLSearchParams())
    expect(r.snapshot().data).toBe(page)
    expect(viewer.snapshot().data).toBe(shown)
  })

  test("a fetcher loading its path again keeps unchanged data, and another path does not share", async () => {
    const r = createClientRouter({
      patterns,
      initial: onList(),
      fetchData: async (path) => ({ path, rows: [{ id: 1 }] }),
    })
    const viewer = r.fetcher("viewer")
    await viewer.load("/users/7")
    const first = viewer.snapshot().data
    await viewer.load("/users/7")
    expect(viewer.snapshot().data).toBe(first)
    await viewer.load("/users/8")
    expect(Reflect.get(Object(viewer.snapshot().data), "rows")).not.toBe(
      Reflect.get(Object(first), "rows"),
    )
  })

  test("a target an intercept boundary holds shares its own reload", async () => {
    const r = createClientRouter({
      patterns,
      initial: onList(),
      routeHooks: { list: { boundaries: [{ name: "photo", mode: { intercept: "/photos/:id" } }] } },
      fetchData: async (path) => (path === "/list" ? listEnvelope() : { photo: { id: path } }),
    })
    await r.navigate("/photos/1")
    const held = r.snapshot().boundaries?.photo?.data
    expect(held).toEqual({ photo: { id: "/photos/1" } })
    await r.invalidate()
    expect(r.snapshot().intercepted).toBeDefined()
    expect(r.snapshot().boundaries?.photo?.data).toBe(held)
  })

  test("a page an action redirected to shares its next reload", async () => {
    answer(() => new Response(null, { headers: { "x-nifra-redirect": "/list" } }))
    const r = createClientRouter({
      patterns,
      initial: onList(),
      fetchData: async (path) => (path === "/list" ? listEnvelope() : { user: { id: 7 } }),
    })
    await r.navigate("/users/7")
    await r.submit("/users/7", new URLSearchParams())
    const landed = r.snapshot()
    expect(landed.path).toBe("/list")
    await r.invalidate()
    expect(r.snapshot().data).toBe(landed.data)
  })

  test("a status page on screen reloads as its URL's route", async () => {
    const r = createClientRouter({
      patterns,
      initial: { routeId: "_404", params: {}, path: "/list", data: null, pending: false },
      fetchData: async () => listEnvelope(),
    })
    await r.invalidate()
    expect(r.snapshot().routeId).toBe("list")
    expect(r.snapshot().data).toEqual(listData())
  })

  test("a shareData = false route gets fresh data", async () => {
    const r = createClientRouter({
      patterns,
      initial: onList(),
      routeHooks: { list: { shareData: false } },
      fetchData: async () => listEnvelope(),
    })
    const before = r.snapshot()
    await r.invalidate()
    expect(r.snapshot().data).toEqual(before.data)
    expect(r.snapshot().data).not.toBe(before.data)
    expect(r.snapshot().layoutData).not.toBe(before.layoutData)
  })

  test("a clientLoader's result shares with what the page shows", async () => {
    let serverRuns = 0
    const r = createClientRouter({
      patterns,
      initial: onList(),
      routeHooks: {
        list: {
          clientLoader: async ({ serverLoader }) => ({
            server: await serverLoader(),
            extra: { local: true },
          }),
        },
      },
      fetchData: async () => {
        serverRuns++
        return listEnvelope()
      },
    })
    await r.invalidate()
    const first = r.snapshot().data
    await r.invalidate()
    expect(serverRuns).toBe(2)
    expect(r.snapshot().data).toBe(first)
  })

  test("a cyclic clientLoader result reloads without changing its graph", async () => {
    type Node = { revision: number; self?: Node }
    let revision = 0
    const r = createClientRouter({
      patterns,
      initial: onList(),
      routeHooks: {
        list: {
          clientLoader: () => {
            const node: Node = { revision: ++revision }
            node.self = node
            return node
          },
        },
      },
    })
    await r.navigate("/list")
    await r.invalidate()
    const data = r.snapshot().data
    expect(data).toMatchObject({ revision: 2 })
    expect(Reflect.get(Object(data), "self")).toBe(data)
    expect(r.snapshot().pending).toBe(false)
  })

  test("a clientLoader can introduce a back-reference inside a new subtree", async () => {
    type Node = { child: { parent: Node } | null }
    let runs = 0
    const r = createClientRouter({
      patterns,
      initial: onList(),
      routeHooks: {
        list: {
          clientLoader: () => {
            const node: Node = { child: null }
            if (++runs > 1) node.child = { parent: node }
            return node
          },
        },
      },
    })
    await r.navigate("/list")
    await r.invalidate()
    const data = r.snapshot().data
    expect(Reflect.get(Object(Reflect.get(Object(data), "child")), "parent")).toBe(data)
  })

  test("a clientLoader's symbol metadata updates and can be removed", async () => {
    const revisionKey = Symbol("revision")
    let revision = 0
    const r = createClientRouter({
      patterns,
      initial: onList(),
      routeHooks: {
        list: {
          clientLoader: () => {
            revision++
            return revision < 3 ? { title: "List", [revisionKey]: revision } : { title: "List" }
          },
        },
      },
    })
    await r.navigate("/list")
    await r.invalidate()
    expect(Reflect.get(Object(r.snapshot().data), revisionKey)).toBe(2)
    await r.invalidate()
    expect(Object.hasOwn(Object(r.snapshot().data), revisionKey)).toBe(false)
  })
})

describe("a reload's request", () => {
  test("a reload offers the server no layout data to keep: every layout loader runs again", async () => {
    const navigations: unknown[] = []
    const r = createClientRouter({
      patterns,
      initial: onList(),
      fetchData: async (path, _match, _signal, navigation) => {
        navigations.push(navigation)
        return path === "/list" ? listEnvelope() : { user: { id: 7 } }
      },
    })
    const viewer = r.fetcher("viewer")
    await viewer.load("/users/7")
    await viewer.load("/users/7")
    await r.invalidate()
    expect(navigations).toEqual([undefined, undefined, undefined])
  })

  test("the default transport aborts with the navigation", async () => {
    const fetched = answer(() => Response.json(listEnvelope()))
    const r = createClientRouter({ patterns, initial: onList(null) })
    await r.navigate("/list")
    expect(fetched.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe("the text fast path", () => {
  // Serves `/list` with whatever `body` holds, as JSON or NDJSON.
  const serve = (body: { text: string; ndjson?: boolean }) => {
    let requests = 0
    answer(() => {
      requests++
      return new Response(body.text, {
        headers: {
          "content-type": body.ndjson === true ? "application/x-ndjson" : "application/json",
        },
      })
    })
    return () => requests
  }
  const text = (labels?: Record<number, string>) => JSON.stringify(listEnvelope(labels))

  test("a reload answering the text the page was read from reuses the page without parsing", async () => {
    const body = { text: text() }
    const requests = serve(body)
    const r = createClientRouter({ patterns, initial: onList(null) })
    await r.navigate("/list")
    const first = r.snapshot()
    const parse = spyOn(JSON, "parse")
    try {
      await r.invalidate()
      expect(requests()).toBe(2)
      expect(parse).not.toHaveBeenCalled()
      expect(changedKeys(first, r.snapshot())).toEqual([])

      body.text = text({ 1: "changed" })
      await r.invalidate()
      expect(parse).toHaveBeenCalledTimes(1)
      const changed = r.snapshot()
      expect(rowsOf(changed)[1]).toEqual({ id: 1, label: "changed" })
      expect(rowsOf(changed)[0]).toBe(rowsOf(first)[0])

      await r.invalidate()
      expect(parse).toHaveBeenCalledTimes(1)
      expect(r.snapshot().data).toBe(changed.data)
    } finally {
      parse.mockRestore()
    }
  })

  test("a response with deferred parts is always parsed", async () => {
    const body = {
      text: '{"title":"List","feed":{"__nifra_deferred":0}}\n{"i":0,"v":1}\n',
      ndjson: true,
    }
    serve(body)
    const r = createClientRouter({ patterns, initial: onList(null) })
    await r.navigate("/list")
    const first = r.snapshot().data
    const parse = spyOn(JSON, "parse")
    try {
      await r.invalidate()
      expect(parse).toHaveBeenCalled()
      const again = r.snapshot().data
      expect(again).not.toBe(first)
      const feed = (data: unknown): unknown => Reflect.get(Object(data), "feed")
      const promise: unknown = Reflect.get(Object(feed(again)), "promise")
      expect(promise).not.toBe(Reflect.get(Object(feed(first)), "promise"))
      expect(await promise).toBe(1)
    } finally {
      parse.mockRestore()
    }
  })

  test("a deferred reload drops the text, so the earlier text is parsed again", async () => {
    const body: { text: string; ndjson?: boolean } = { text: text() }
    serve(body)
    const r = createClientRouter({ patterns, initial: onList(null) })
    await r.navigate("/list")
    // A deferred response replaces the page with data no text describes.
    body.ndjson = true
    body.text = `${JSON.stringify({ v: 1, data: { title: "Deferred" } })}\n`
    await r.invalidate()
    expect(r.snapshot().data).toEqual({ title: "Deferred" })
    // The first text again describes data no longer on screen: it is parsed and shown.
    body.ndjson = false
    body.text = text()
    await r.invalidate()
    expect(r.snapshot().data).toEqual(listData())
  })

  test("a shareData = false route parses every reload", async () => {
    const body = { text: text() }
    serve(body)
    const r = createClientRouter({
      patterns,
      initial: onList(null),
      routeHooks: { list: { shareData: false } },
    })
    await r.navigate("/list")
    const first = r.snapshot().data
    await r.invalidate()
    expect(r.snapshot().data).toEqual(first)
    expect(r.snapshot().data).not.toBe(first)
  })

  test("a route with a clientLoader parses every reload", async () => {
    const body = { text: text() }
    serve(body)
    const seen: unknown[] = []
    const r = createClientRouter({
      patterns,
      initial: onList(null),
      routeHooks: {
        list: {
          clientLoader: async ({ serverLoader }) => {
            const server = await serverLoader()
            seen.push(server)
            return { wrapped: server }
          },
        },
      },
    })
    await r.navigate("/list")
    await r.invalidate()
    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual(listData())
    expect(r.snapshot().data).toEqual({ wrapped: listData() })
  })
})
