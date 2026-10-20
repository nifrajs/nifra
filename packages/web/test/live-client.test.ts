/**
 * The browser live client against a scripted server: the test plays the load endpoint and the socket,
 * so every load and every frame the client sends is checked, and the server's answers are exact.
 */
import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test"
import type { BoundaryStates } from "../src/boundary.ts"
import { liveClient } from "../src/live-client.ts"
import { type ClientRouter, createClientRouter, type RouterState } from "../src/router.ts"

const SID = "a".repeat(32)
const SID_2 = "b".repeat(32)
const ROOT = "L:_layout"
const POST = "P:posts/[id]"

const patterns = [
  { routeId: "index", pattern: "/" },
  { routeId: "posts/[id]", pattern: "/posts/:id" },
  { routeId: "about", pattern: "/about" },
  { routeId: "photo", pattern: "/photos/:id" },
]
const layoutIdsOf = {
  index: ["_layout"],
  "posts/[id]": ["_layout"],
  about: ["_layout"],
  photo: ["_layout"],
}
const pageBoundaries: BoundaryStates = {
  photo: { name: "photo", mode: { intercept: "/photos/:id" }, status: "unresolved" },
}
const routeHooks = {
  index: { boundaries: [{ name: "photo", mode: { intercept: "/photos/:id" } }] },
}

class FakeSocket {
  static all: FakeSocket[] = []
  readyState = 0
  readonly sent: string[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  closedWith: number | undefined
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(code?: number): void {
    this.readyState = 3
    this.closedWith = code
  }
  welcome(sid = SID): void {
    this.readyState = 1
    this.deliver({ t: "welcome", sid })
  }
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  drop(code: number): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
  watches(): { t: string; gen: number; grants: string[] }[] {
    return this.sent.filter((frame) => frame !== "p").map((frame) => JSON.parse(frame))
  }
  lastWatch(): { t: string; gen: number; grants: string[] } {
    const watch = this.watches().at(-1)
    if (watch === undefined) throw new Error("no watch sent")
    return watch
  }
}

/** A document the test can hide and show. */
class FakeDocument {
  visibilityState: "visible" | "hidden" = "visible"
  private readonly listeners = new Set<() => void>()
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.add(listener)
  }
  removeEventListener(_type: string, listener: () => void): void {
    this.listeners.delete(listener)
  }
  show(): void {
    this.visibilityState = "visible"
    for (const listener of this.listeners) listener()
  }
}

const saved = { WebSocket: Reflect.get(globalThis, "WebSocket"), fetch: globalThis.fetch }
let doc: FakeDocument
beforeEach(() => {
  FakeSocket.all = []
  Reflect.set(globalThis, "WebSocket", FakeSocket)
  doc = new FakeDocument()
  Reflect.set(globalThis, "document", doc)
})
afterEach(() => {
  jest.useRealTimers()
  Reflect.set(globalThis, "WebSocket", saved.WebSocket)
  Reflect.deleteProperty(globalThis, "document")
  globalThis.fetch = saved.fetch
})

interface LoadBody {
  readonly path: string
  readonly sid: string
  readonly frame: string
  readonly mode: "load" | "renew"
  readonly retain: readonly string[]
  readonly grants: readonly string[]
}

const routeOf = (path: string): string => {
  const pathname = path.split("?")[0] ?? path
  if (pathname === "/") return "index"
  if (pathname === "/about") return "about"
  if (pathname.startsWith("/photos/")) return "photo"
  return "posts/[id]"
}

/**
 * The live load endpoint as the client sees it: each answer issues `grant-<n>`, watches `tag:<path>`
 * for the page owner and `tag:root` for the root layout, and keeps what a valid grant lets it keep.
 */
function scripted() {
  const loads: LoadBody[] = []
  const plain: string[] = []
  const issued = new Map<string, LoadBody>()
  const held: (() => void)[] = []
  const control = { hold: false, busy: 0, failing: 0, subject: "viewer-1", grant: true }
  let n = 0
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    if (input !== "/_nifra/live/load") {
      plain.push(input)
      return Response.json({ v: 1, data: { path: input, plain: true }, layoutData: [{ root: 0 }] })
    }
    const body: LoadBody = JSON.parse(String(init.body))
    loads.push(body)
    if (control.hold) await new Promise<void>((resolve) => held.push(resolve))
    if (control.busy > 0) {
      control.busy--
      return new Response("busy", { status: 503 })
    }
    if (control.failing > 0) {
      control.failing--
      return new Response("down", { status: 500 })
    }
    const id = ++n
    const routeId = routeOf(body.path)
    const presented = body.grants
      .map((grant) => issued.get(grant))
      .find((load) => load !== undefined && load.sid === body.sid)
    const renew = body.mode === "renew" && presented?.path === body.path
    const keepRoot = presented !== undefined && (renew || body.retain.includes(ROOT))
    const keepPage =
      presented?.path === body.path && (renew || body.retain.includes(`P:${routeId}`))
    const grant = `grant-${id}`
    issued.set(grant, body)
    const live: Record<string, unknown> = {
      subject: control.subject,
      tags: { [`tag:${body.path}`]: [`P:${routeId}`], "tag:root": [ROOT] },
      ttl: 600,
    }
    if (control.grant) live.grant = grant
    if (keepPage) live.page = "retained"
    return Response.json({
      v: 1,
      data: keepPage ? null : { path: body.path, n: id },
      layoutData: [keepRoot ? null : { root: id }],
      retained: keepRoot ? [0] : [],
      live,
      boundaries: routeId === "index" ? pageBoundaries : undefined,
    })
  }
  const release = (): void => {
    control.hold = false
    for (const resolve of held.splice(0)) resolve()
  }
  return { fetch, loads, plain, issued, control, release, held }
}

const initial = (path = "/posts/1"): RouterState => {
  const state: RouterState = {
    routeId: routeOf(path),
    params: path.startsWith("/posts/") ? { id: path.slice(7) } : {},
    path,
    data: { path, n: 0 },
    layoutData: [{ root: 0 }],
    pending: false,
  }
  return path === "/" ? { ...state, boundaries: pageBoundaries } : state
}

/** Turn the event loop until `ok()`; no clock involved. */
async function until(ok: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 5000; turn++) {
    if (ok()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`[test] never: ${what}`)
}

/** Let everything already started run out. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 200; turn++) await new Promise((resolve) => setImmediate(resolve))
}

interface Rig {
  readonly server: ReturnType<typeof scripted>
  readonly router: ClientRouter
  readonly socket: () => FakeSocket
  readonly stop: () => void
}

function rig(path = "/posts/1"): Rig {
  const server = scripted()
  const client = liveClient({ fetch: server.fetch, layoutIdsOf })
  const router = createClientRouter({
    patterns,
    initial: initial(path),
    fetchData: client.fetchData,
    routeHooks,
  })
  const stop = client.attach(router)
  const socket = (): FakeSocket => {
    const last = FakeSocket.all.at(-1)
    if (last === undefined) throw new Error("no socket")
    return last
  }
  return { server, router, socket, stop }
}

/** The first live load after hydration, its watch, and a `ready` with nothing stale. */
async function connected(path = "/posts/1"): Promise<Rig> {
  const r = rig(path)
  r.socket().welcome()
  await until(() => r.socket().watches().length === 1, "first watch")
  ready(r, [[]])
  await settle()
  return r
}

function ready(r: Rig, stale: readonly (readonly string[])[]): void {
  r.socket().deliver({ t: "ready", gen: r.socket().lastWatch().gen, stale })
}

const changed = (r: Rig, tag: string): void => r.socket().deliver({ t: "changed", tag, spread: 0 })

// --- Connecting -----------------------------------------------------------------------------------

test("the first live load waits for the socket's id, then watches its grant; nothing stale, nothing more", async () => {
  const r = rig()
  await settle()
  expect(r.server.loads).toEqual([])
  r.socket().welcome()
  await until(() => r.socket().watches().length === 1, "watch")
  expect(r.server.loads).toEqual([
    { path: "/posts/1", sid: SID, frame: "page", mode: "load", retain: [], grants: [] },
  ])
  expect(r.router.snapshot().data).toEqual({ path: "/posts/1", n: 1 })
  expect(r.socket().watches()).toEqual([{ t: "watch", gen: 1, grants: ["grant-1"] }])
  ready(r, [[]])
  await settle()
  expect(r.server.loads).toHaveLength(1)
  r.stop()
})

// --- Changes ----------------------------------------------------------------------------------------

test("a change reloads only the owner that read it: the rest is kept and shown from screen", async () => {
  const r = await connected()
  changed(r, "tag:/posts/1")
  await until(() => r.server.loads.length === 2 && !r.router.snapshot().pending, "reload")
  expect(r.server.loads[1]).toEqual({
    path: "/posts/1",
    sid: SID,
    frame: "page",
    mode: "load",
    retain: [ROOT],
    grants: ["grant-1"],
  })
  const state = r.router.snapshot()
  expect(state.data).toEqual({ path: "/posts/1", n: 2 })
  // The server kept the root layout: the copy on screen stays.
  expect(state.layoutData).toEqual([{ root: 1 }])
  await until(() => r.socket().watches().length === 2, "rewatch")
  expect(r.socket().lastWatch()).toEqual({ t: "watch", gen: 2, grants: ["grant-2"] })
  r.stop()
})

test("a tag the frame does not hold is ignored", async () => {
  const r = await connected()
  changed(r, "tag:/posts/2")
  changed(r, "not-a-tag")
  r.socket().deliver({ t: "changed" })
  await settle()
  expect(r.server.loads).toHaveLength(1)
  r.stop()
})

test("changes during a load union into exactly one more load, decided by ready.stale", async () => {
  const r = await connected()
  r.server.control.hold = true
  changed(r, "tag:/posts/1")
  await until(() => r.server.loads.length === 2, "reload starts")
  changed(r, "tag:/posts/1")
  changed(r, "tag:root")
  changed(r, "tag:/posts/1")
  await settle()
  expect(r.server.loads).toHaveLength(2)
  r.server.release()
  await until(() => r.socket().watches().length === 2, "rewatch")
  // What changed after the load read is in `stale`: one more load, keeping what did not change.
  ready(r, [[POST]])
  await until(() => r.server.loads.length === 3 && !r.router.snapshot().pending, "one more")
  expect(r.server.loads[2]?.retain).toEqual([ROOT])
  await until(() => r.socket().watches().length === 3, "third watch")
  ready(r, [[]])
  await settle()
  expect(r.server.loads).toHaveLength(3)
  r.stop()
})

test("a pending frame ignores changes until its ready, and a ready for an older watch is ignored", async () => {
  const r = rig()
  r.socket().welcome()
  await until(() => r.socket().watches().length === 1, "watch")
  changed(r, "tag:/posts/1")
  r.socket().deliver({ t: "ready", gen: 0, stale: [[POST]] })
  await settle()
  expect(r.server.loads).toHaveLength(1)
  ready(r, [[POST]])
  await until(() => r.server.loads.length === 2, "stale reload")
  r.stop()
})

// --- The tab's own action -------------------------------------------------------------------------

function actionServer() {
  const answered: (() => void)[] = []
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        await new Promise<void>((resolve) => answered.push(resolve))
        return Response.json({ ok: true })
      },
      { preconnect: () => {} },
    ),
  )
  const answer = (): void => {
    for (const resolve of answered.splice(0)) resolve()
  }
  return { spy, answer }
}

test("the tab's own action costs exactly one load: its publish lands during it and ready shows it covered", async () => {
  const r = await connected()
  const action = actionServer()
  const submitting = r.router.submit("/posts/1", new FormData())
  await until(() => action.spy.mock.calls.length === 1, "action posted")
  // The action's own publish arrives before its answer: the router is busy, so no load starts.
  changed(r, "tag:/posts/1")
  await settle()
  expect(r.server.loads).toHaveLength(1)
  action.answer()
  await submitting
  // The revalidation is the router's own: a full load, nothing offered to keep.
  expect(r.server.loads).toHaveLength(2)
  expect(r.server.loads[1]).toMatchObject({ mode: "load", retain: [], grants: [] })
  await until(() => r.socket().watches().length === 2, "rewatch")
  ready(r, [[]])
  await settle()
  expect(r.server.loads).toHaveLength(2)
  r.stop()
})

test("an action plus an external change in one window reloads until fresh", async () => {
  const r = await connected()
  const action = actionServer()
  const submitting = r.router.submit("/posts/1", new FormData())
  await until(() => action.spy.mock.calls.length === 1, "action posted")
  action.answer()
  await submitting
  await until(() => r.socket().watches().length === 2, "rewatch")
  // Another write after the revalidation read: stale, so one more load.
  ready(r, [[POST]])
  await until(() => r.server.loads.length === 3 && !r.router.snapshot().pending, "fresh again")
  await until(() => r.socket().watches().length === 3, "third watch")
  ready(r, [[]])
  await settle()
  expect(r.server.loads).toHaveLength(3)
  r.stop()
})

// --- Failures -------------------------------------------------------------------------------------

test("a failed load stays dirty: three retries with backoff, then it waits for the next change", async () => {
  const r = await connected()
  jest.useFakeTimers()
  r.server.control.failing = 100
  changed(r, "tag:/posts/1")
  await until(() => r.server.loads.length === 2, "first try")
  for (const attempt of [3, 4, 5]) {
    await settle()
    jest.advanceTimersByTime(5_000)
    await until(() => r.server.loads.length === attempt, `retry ${attempt}`)
  }
  await settle()
  jest.advanceTimersByTime(120_000)
  await settle()
  expect(r.server.loads).toHaveLength(5)
  r.server.control.failing = 0
  changed(r, "tag:/posts/1")
  await until(() => r.server.loads.length === 6 && !r.router.snapshot().pending, "next change")
  expect(r.router.snapshot().data).toEqual({ path: "/posts/1", n: 2 })
  r.stop()
})

test("a busy endpoint fails a live reload but sends a navigation through the plain data request", async () => {
  const r = await connected()
  r.server.control.busy = 1
  await r.router.navigate("/about")
  expect(r.server.plain).toEqual(["/about"])
  expect(r.router.snapshot().data).toEqual({ path: "/about", plain: true })
  // The plain answer has no grant: one live load fetches it.
  await until(() => r.server.loads.length === 3 && !r.router.snapshot().pending, "grant load")
  expect(r.server.loads[2]).toMatchObject({ path: "/about", retain: [], grants: [] })
  r.stop()
})

// --- Navigation -----------------------------------------------------------------------------------

test("a navigation mid-reload wins: the reload is dropped and the new page's grant is watched", async () => {
  const r = await connected()
  r.server.control.hold = true
  changed(r, "tag:/posts/1")
  await until(() => r.server.loads.length === 2, "reload starts")
  const navigating = r.router.navigate("/about")
  await until(() => r.server.loads.length === 3, "navigation load")
  // The navigation presents the page it leaves and offers the root layout, which did not change.
  expect(r.server.loads[2]).toEqual({
    path: "/about",
    sid: SID,
    frame: "page",
    mode: "load",
    retain: [ROOT],
    grants: ["grant-1"],
  })
  r.server.release()
  await navigating
  await until(() => r.socket().watches().length === 2, "rewatch")
  expect(r.router.snapshot().path).toBe("/about")
  const watched = r.server.issued.get(r.socket().lastWatch().grants[0] ?? "")
  expect(watched?.path).toBe("/about")
  ready(r, [[]])
  await settle()
  expect(r.server.loads).toHaveLength(3)
  r.stop()
})

test("a navigation never offers a layout whose keys changed", async () => {
  const r = await connected()
  doc.visibilityState = "hidden"
  changed(r, "tag:root")
  await settle()
  expect(r.server.loads).toHaveLength(1)
  await r.router.navigate("/about")
  expect(r.server.loads[1]).toMatchObject({ path: "/about", retain: [], grants: ["grant-1"] })
  r.stop()
})

// --- Intercept boundaries (G7) ---------------------------------------------------------------------

test("an open boundary watches beside the page; its change reloads the target alone", async () => {
  const r = await connected("/")
  await r.router.navigate("/photos/9")
  const state = r.router.snapshot()
  expect(state.intercepted).toEqual({ boundary: "photo", pagePath: "/" })
  await until(() => r.socket().watches().length === 2, "both frames")
  const watch = r.socket().lastWatch()
  expect(watch.grants.map((grant) => r.server.issued.get(grant)?.path)).toEqual(["/", "/photos/9"])
  ready(r, [[], []])
  await settle()
  const before = r.server.loads.length
  changed(r, "tag:/photos/9")
  await until(() => r.server.loads.length === before + 1 && !r.router.snapshot().pending, "target")
  expect(r.server.loads.at(-1)?.path).toBe("/photos/9")
  expect(r.router.snapshot().data).toEqual(state.data)
  await until(() => r.socket().watches().length === 3, "rewatch")
  expect(r.socket().lastWatch().grants[0]).toBe(watch.grants[0])
  // `stale` is per grant: the page's root is not the boundary's.
  ready(r, [[], [ROOT]])
  await until(() => r.server.loads.length === before + 2, "boundary root")
  expect(r.server.loads.at(-1)?.path).toBe("/photos/9")
  r.stop()
})

// --- Renewal and polling --------------------------------------------------------------------------

test("a grant renews a minute before it expires, never while the tab is hidden", async () => {
  jest.useFakeTimers()
  const r = await connected()
  jest.advanceTimersByTime(8 * 60_000)
  await settle()
  expect(r.server.loads).toHaveLength(1)
  doc.visibilityState = "hidden"
  jest.advanceTimersByTime(90_000)
  await settle()
  expect(r.server.loads).toHaveLength(1)
  doc.show()
  await until(() => r.server.loads.length === 2 && !r.router.snapshot().pending, "renewal")
  expect(r.server.loads[1]).toEqual({
    path: "/posts/1",
    sid: SID,
    frame: "page",
    mode: "renew",
    retain: [],
    grants: ["grant-1"],
  })
  // Kept whole: the data on screen stays.
  expect(r.router.snapshot().data).toEqual({ path: "/posts/1", n: 1 })
  expect(r.router.snapshot().layoutData).toEqual([{ root: 1 }])
  r.stop()
})

test("a load with no grant polls every 30 s or so, and nothing is watched", async () => {
  jest.useFakeTimers()
  const r = rig()
  r.server.control.grant = false
  r.socket().welcome()
  await until(() => r.server.loads.length === 1 && !r.router.snapshot().pending, "first load")
  await settle()
  expect(r.socket().watches()).toEqual([])
  jest.advanceTimersByTime(23_000)
  await settle()
  expect(r.server.loads).toHaveLength(1)
  jest.advanceTimersByTime(14_000)
  await until(() => r.server.loads.length === 2, "poll")
  expect(r.server.loads[1]).toMatchObject({ retain: [], grants: [] })
  r.stop()
})

test("with the socket failing to connect, the page polls instead", async () => {
  jest.useFakeTimers()
  const r = rig()
  for (let i = 0; i < 3; i++) {
    r.socket().drop(1006)
    jest.advanceTimersByTime(60_000)
    await settle()
  }
  expect(FakeSocket.all.length).toBeGreaterThanOrEqual(4)
  jest.advanceTimersByTime(40_000)
  await until(() => r.server.loads.length >= 1, "poll")
  // Bound to an id no socket has: the grant is never watched.
  expect(r.server.loads[0]?.sid).not.toBe(SID)
  expect(r.server.loads[0]?.sid).toMatch(/^[0-9a-f]{32}$/)
  r.stop()
})

// --- Account switch -------------------------------------------------------------------------------

test("another viewer: a new socket, every cache cleared, one load under it", async () => {
  const r = await connected()
  await r.router.prefetch("/about")
  r.server.control.subject = "viewer-2"
  changed(r, "tag:/posts/1")
  await until(() => FakeSocket.all.length === 2, "new socket")
  expect(FakeSocket.all[0]?.closedWith).toBe(1000)
  const loads = r.server.loads.length
  r.socket().welcome(SID_2)
  await until(() => r.socket().watches().length === 1, "watch on the new socket")
  expect(r.server.loads.slice(loads)).toEqual([
    { path: "/posts/1", sid: SID_2, frame: "page", mode: "load", retain: [], grants: [] },
  ])
  ready(r, [[]])
  await settle()
  // The prefetched page was the last viewer's: the navigation loads it again.
  const before = r.server.loads.length
  await r.router.navigate("/about")
  expect(r.server.loads.length).toBe(before + 1)
  r.stop()
})

// --- Disclosure -----------------------------------------------------------------------------------

test("the client sends only paths, owner ids and opaque grants: no seq, subject or key", async () => {
  const r = await connected()
  changed(r, "tag:/posts/1")
  await until(() => r.socket().watches().length === 2, "rewatch")
  for (const body of r.server.loads) {
    expect(Object.keys(body).sort()).toEqual(["frame", "grants", "mode", "path", "retain", "sid"])
  }
  for (const frame of r.socket().sent) {
    if (frame === "p") continue
    expect(Object.keys(JSON.parse(frame)).sort()).toEqual(["gen", "grants", "t"])
  }
  // Router state carries the client's own handle, never the server's envelope.
  expect(JSON.stringify(r.router.snapshot().live ?? null)).not.toContain("viewer-1")
  r.stop()
})

test("detaching closes the socket and stops reloading", async () => {
  const r = await connected()
  r.stop()
  expect(r.socket().closedWith).toBe(1000)
  changed(r, "tag:/posts/1")
  await settle()
  expect(r.server.loads).toHaveLength(1)
})
