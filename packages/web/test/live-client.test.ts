/**
 * The browser live client against a scripted server: the test plays the load endpoint and the socket,
 * so every load and every frame the client sends is checked, and the server's answers are exact.
 */
import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test"
import type { BoundaryStates } from "../src/boundary.ts"
import { liveQueries } from "../src/internal/live-queries.ts"
import { queryDigester, querySalt } from "../src/internal/query-digest.ts"
import { liveClient } from "../src/live-client.ts"
import { createQueryClient, type QueryHandle } from "../src/query.ts"
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
  welcome(sid = SID, spread?: number): void {
    this.readyState = 1
    this.deliver(spread === undefined ? { t: "welcome", sid } : { t: "welcome", sid, spread })
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
 * Their keys are `key:<path>` and `key:root`; `query` adds what query hooks match them by.
 */
function scripted() {
  const loads: LoadBody[] = []
  const plain: string[] = []
  const issued = new Map<string, LoadBody>()
  const held: (() => void)[] = []
  const control: {
    hold: boolean
    busy: number
    failing: number
    subject: string
    /** The viewer tags one load carries, as a process mid-rotation lists them. */
    subjects: readonly string[] | undefined
    /** Whether a load's grant holds any key: a page with none has nothing to watch. */
    tags: boolean
    grant: boolean
    query: undefined | "keys" | "off" | "bad"
    dev: boolean
  } = {
    hold: false,
    busy: 0,
    failing: 0,
    subject: "viewer-1",
    subjects: undefined,
    tags: true,
    grant: true,
    query: undefined,
    dev: false,
  }
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
      subjects: control.subjects ?? [control.subject],
      tags: control.tags ? { [`tag:${body.path}`]: [`P:${routeId}`], "tag:root": [ROOT] } : {},
      ttl: 600,
    }
    if (control.grant) live.grant = grant
    if (keepPage) live.page = "retained"
    if (control.query === "keys") {
      const salt = querySalt()
      const digest = await queryDigester(salt)
      const query: Record<string, unknown> = {
        salt,
        keys: {
          [`tag:${body.path}`]: await digest(`key:${body.path}`),
          "tag:root": await digest("key:root"),
        },
      }
      if (control.dev) query.dev = true
      live.query = query
    } else if (control.query === "off") live.query = { dev: true }
    else if (control.query === "bad") live.query = { salt: 7 }
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

test("a failed load stays dirty and keeps retrying, backing off to five minutes, never giving up", async () => {
  const r = await connected()
  jest.useFakeTimers()
  r.server.control.failing = 100
  changed(r, "tag:/posts/1")
  await until(() => r.server.loads.length === 2, "first try")
  // 1, 2, 4 and 8 s, each within 20% of its step: one retry per wait, never two.
  for (const [attempt, wait] of [
    [3, 1200],
    [4, 2400],
    [5, 4800],
    [6, 9600],
  ] as const) {
    await settle()
    jest.advanceTimersByTime(wait)
    await until(() => r.server.loads.length === attempt, `retry ${attempt}`)
  }
  // Past any count of failures, the next try is at most five minutes off.
  for (let round = 0; round < 8; round++) {
    const before = r.server.loads.length
    await settle()
    jest.advanceTimersByTime(300_000)
    await until(() => r.server.loads.length > before, `a retry within five minutes, round ${round}`)
  }
  // The server recovers with no change to announce it: the next retry shows fresh data.
  r.server.control.failing = 0
  await settle()
  jest.advanceTimersByTime(300_000)
  await until(() => !r.router.snapshot().pending && r.router.snapshot().data !== null, "recovered")
  await settle()
  expect(r.router.snapshot().data).toEqual({ path: "/posts/1", n: 2 })
  r.stop()
})

test("a change tries a failing frame again at once, whatever its backoff", async () => {
  const r = await connected()
  jest.useFakeTimers()
  r.server.control.failing = 2
  changed(r, "tag:/posts/1")
  await until(() => r.server.loads.length === 2, "first try")
  await settle()
  jest.advanceTimersByTime(1200)
  await until(() => r.server.loads.length === 3, "second try")
  await settle()
  changed(r, "tag:/posts/1")
  await until(() => r.server.loads.length === 4 && !r.router.snapshot().pending, "the change")
  expect(r.router.snapshot().data).toEqual({ path: "/posts/1", n: 2 })
  r.stop()
})

test("a frame deep in its backoff reloads at once under a new socket", async () => {
  const r = await connected()
  jest.useFakeTimers()
  r.server.control.failing = 100
  changed(r, "tag:/posts/1")
  await until(() => r.server.loads.length === 2, "first try")
  for (const [attempt, wait] of [
    [3, 1200],
    [4, 2400],
    [5, 4800],
  ] as const) {
    await settle()
    jest.advanceTimersByTime(wait)
    await until(() => r.server.loads.length === attempt, `retry ${attempt}`)
  }
  r.server.control.failing = 0
  r.socket().drop(1006)
  await settle()
  jest.advanceTimersByTime(1200)
  await until(() => FakeSocket.all.length === 2, "reconnect")
  const before = r.server.loads.length
  r.socket().welcome(SID_2)
  await until(() => r.server.loads.length === before + 1, "a load under the new socket")
  expect(r.server.loads.at(-1)?.sid).toBe(SID_2)
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

/** Zero-delay timers armed while `ms` of fake time passes: a frame with nothing due arms none. */
function spinsOver(ms: number): number {
  let zero = 0
  const faked = globalThis.setTimeout
  const count = (fn: () => void, delay?: number) => {
    if ((delay ?? 0) <= 0) zero++
    return faked(fn, delay)
  }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a counter cannot meet every setTimeout overload; the client only ever passes a callback and a delay
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(count as never)
  try {
    jest.advanceTimersByTime(ms)
  } finally {
    spy.mockRestore()
  }
  return zero
}

test("a failed renewal waits out its backoff without spinning, then renews again", async () => {
  jest.useFakeTimers()
  const r = await connected()
  r.server.control.busy = 1
  jest.advanceTimersByTime(10 * 60_000)
  await until(() => r.server.loads.length === 2 && !r.router.snapshot().pending, "failed renewal")
  await settle()
  // The renewal stays overdue; the retry 0.8 s or more away is the only deadline.
  expect(spinsOver(700)).toBe(0)
  expect(r.server.loads).toHaveLength(2)
  jest.advanceTimersByTime(600)
  await until(() => r.server.loads.length === 3, "renewal retried")
  expect(r.server.loads[2]).toMatchObject({ mode: "renew" })
  r.stop()
})

test("a failed poll waits for its next poll without spinning once its retry is due", async () => {
  jest.useFakeTimers()
  const r = rig()
  r.server.control.grant = false
  r.socket().welcome()
  await until(() => r.server.loads.length === 1 && !r.router.snapshot().pending, "first load")
  r.server.control.busy = 1
  jest.advanceTimersByTime(40_000)
  await until(() => r.server.loads.length === 2 && !r.router.snapshot().pending, "failed poll")
  await settle()
  // The retry falls due in about a second; the poll that runs it not for 48 s or more.
  expect(spinsOver(10_000)).toBe(0)
  expect(r.server.loads).toHaveLength(2)
  jest.advanceTimersByTime(65_000)
  await until(() => r.server.loads.length === 3, "next poll")
  r.stop()
})

test("a failed load for a grant under a new socket retries with backoff, without spinning", async () => {
  const r = await connected()
  jest.useFakeTimers()
  r.socket().drop(1006)
  await settle()
  jest.advanceTimersByTime(1200)
  await until(() => FakeSocket.all.length === 2, "reconnect")
  const before = r.server.loads.length
  r.server.control.busy = 1
  r.socket().welcome(SID_2)
  await until(
    () => r.server.loads.length === before + 1 && !r.router.snapshot().pending,
    "failed load",
  )
  await settle()
  expect(spinsOver(5_000)).toBe(0)
  await until(() => r.server.loads.length === before + 2, "load retried")
  expect(r.server.loads.at(-1)).toMatchObject({ sid: SID_2, grants: [] })
  await until(() => r.socket().watches().length === 1, "watch on the new socket")
  r.stop()
})

test("a renewal due while its watch waits for ready neither spins nor runs until ready", async () => {
  const r = await connected()
  jest.useFakeTimers()
  r.socket().drop(1006)
  await settle()
  jest.advanceTimersByTime(1200)
  await until(() => FakeSocket.all.length === 2, "reconnect")
  r.socket().welcome(SID_2)
  await until(() => r.socket().watches().length === 1, "watch on the new socket")
  const before = r.server.loads.length
  jest.advanceTimersByTime(9 * 60_000)
  expect(spinsOver(1000)).toBe(0)
  expect(r.server.loads).toHaveLength(before)
  ready(r, [[]])
  await until(() => r.server.loads.length === before + 1, "renewal after ready")
  expect(r.server.loads.at(-1)).toMatchObject({ mode: "renew", sid: SID_2 })
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

test("mid-rotation, loads from processes that list the secrets differently are one viewer", async () => {
  const r = await connected()
  const reload = async (subjects: readonly string[], loads: number): Promise<void> => {
    r.server.control.subjects = subjects
    changed(r, "tag:/posts/1")
    await until(() => r.server.loads.length === loads && !r.router.snapshot().pending, "reload")
    await until(() => r.socket().watches().length === loads, "rewatch")
    ready(r, [[]])
    await settle()
  }
  // [old] and [new, old] side by side, then [new, old] and [new]: one tag in common each time.
  await reload(["viewer-1-new", "viewer-1"], 2)
  await reload(["viewer-1"], 3)
  await reload(["viewer-1-new", "viewer-1"], 4)
  await reload(["viewer-1-new"], 5)
  expect(FakeSocket.all).toHaveLength(1)
  // A tag in common with none: another viewer.
  r.server.control.subjects = ["viewer-2-new", "viewer-2"]
  changed(r, "tag:/posts/1")
  await until(() => FakeSocket.all.length === 2, "new socket")
  r.stop()
})

test("a page with nothing to watch lets its socket go; a page with a key opens one again", async () => {
  const r = rig()
  r.server.control.tags = false
  r.socket().welcome()
  await until(() => r.socket().watches().length === 1, "first watch")
  ready(r, [[]])
  await settle()
  jest.useFakeTimers()
  // The server lets a socket holding no tag go after a minute.
  r.socket().drop(1000)
  for (let turn = 0; turn < 4; turn++) {
    jest.advanceTimersByTime(60_000)
    await settle()
  }
  expect(FakeSocket.all).toHaveLength(1)
  r.server.control.tags = true
  await r.router.navigate("/about")
  await until(() => FakeSocket.all.length === 2, "a socket for the key")
  r.socket().welcome(SID_2)
  await until(() => r.socket().watches().length === 1, "watch on the new socket")
  expect(r.server.loads.at(-1)?.sid).toBe(SID_2)
  r.stop()
})

test("a welcome that asks for a spread holds the reloads a new socket id needs over it", async () => {
  const r = await connected()
  jest.useFakeTimers()
  const random = spyOn(Math, "random").mockReturnValue(0.5)
  r.socket().drop(1013)
  await settle()
  jest.advanceTimersByTime(6000)
  await until(() => FakeSocket.all.length === 2, "reconnect")
  const before = r.server.loads.length
  r.socket().welcome(SID_2, 4000)
  await settle()
  jest.advanceTimersByTime(1999)
  await settle()
  expect(r.server.loads).toHaveLength(before)
  jest.advanceTimersByTime(1)
  await until(() => r.server.loads.length === before + 1, "the held reload")
  random.mockRestore()
  r.stop()
})

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

// --- Query hooks ----------------------------------------------------------------------------------

/** A query the page's code mounted with live keys; the test counts its fetches. */
function mounted(live: readonly string[], client = createQueryClient({ now: () => Date.now() })) {
  let fetches = 0
  const handle: QueryHandle<number> = client.query(["q", ...live], async () => ++fetches, { live })
  const off = handle.subscribe(() => {})
  void handle.fetch()
  return { client, fetches: () => fetches, off }
}

async function connectedWithQueries(): Promise<Rig> {
  const r = rig()
  r.server.control.query = "keys"
  r.socket().welcome()
  await until(() => r.socket().watches().length === 1, "first watch")
  ready(r, [[]])
  await settle()
  return r
}

test("a query on a granted key refetches once its watch begins, then on each change to that key alone", async () => {
  const r = rig()
  r.server.control.query = "keys"
  const query = mounted(["key:/posts/1"])
  const other = mounted(["key:/posts/2"])
  await settle()
  r.socket().welcome()
  await until(() => r.socket().watches().length === 1, "watch")
  await settle()
  expect(query.fetches()).toBe(1)
  // It read before the load took its watermark: a change between the two would be lost.
  ready(r, [[]])
  await until(() => query.fetches() === 2, "the watch's first refetch")
  changed(r, "tag:/posts/1")
  await until(() => query.fetches() === 3, "refetch on change")
  changed(r, "tag:root")
  await settle()
  expect(query.fetches()).toBe(3)
  expect(other.fetches()).toBe(1)
  // Key text and digests stay on the page.
  for (const body of r.server.loads) expect(JSON.stringify(body)).not.toContain("key:")
  for (const frame of r.socket().sent) expect(frame).not.toContain("key:")
  query.off()
  other.off()
  r.stop()
})

test("a query that read after its load arrived is not fetched again when the watch begins", async () => {
  const r = rig()
  r.server.control.query = "keys"
  r.socket().welcome()
  await until(() => r.socket().watches().length === 1, "watch")
  const query = mounted(["key:/posts/1"])
  await settle()
  ready(r, [[]])
  await settle()
  expect(query.fetches()).toBe(1)
  changed(r, "tag:/posts/1")
  await until(() => query.fetches() === 2, "refetch on change")
  query.off()
  r.stop()
})

test("a change that lands before the page has matched a new query still refetches it", async () => {
  const r = await connectedWithQueries()
  const query = mounted(["key:/posts/1"])
  changed(r, "tag:/posts/1")
  await until(() => query.fetches() === 2, "refetch once matched")
  await settle()
  expect(query.fetches()).toBe(2)
  query.off()
  r.stop()
})

test("data fetched before its query mounted is fetched again: changes until then never reached it", async () => {
  const r = await connectedWithQueries()
  const client = createQueryClient({ now: () => Date.now(), staleTime: 60_000 })
  let fetches = 0
  const fetcher = async () => ++fetches
  await client.prefetchQuery(["warm"], fetcher, { live: ["key:/posts/1"] })
  // A change now finds no registered query.
  changed(r, "tag:/posts/1")
  await settle()
  const handle = client.query(["warm"], fetcher, { live: ["key:/posts/1"] })
  const off = handle.subscribe(() => {})
  void handle.fetch()
  expect(fetches).toBe(1)
  await until(() => fetches === 2, "refetch on mount")
  off()
  r.stop()
})

test("a change in ready.stale refetches every query on a tag its owner holds", async () => {
  const r = rig()
  r.server.control.query = "keys"
  r.socket().welcome()
  await until(() => r.socket().watches().length === 1, "watch")
  const root = mounted(["key:root"])
  const page = mounted(["key:/posts/1"])
  await settle()
  ready(r, [[ROOT]])
  await until(() => root.fetches() === 2, "stale refetch")
  await settle()
  expect(root.fetches()).toBe(2)
  expect(page.fetches()).toBe(1)
  root.off()
  page.off()
  r.stop()
})

test("an unmounted query is not refetched", async () => {
  const r = await connectedWithQueries()
  const query = mounted(["key:/posts/1"])
  await settle()
  query.off()
  expect([...liveQueries()]).toEqual([])
  changed(r, "tag:/posts/1")
  await settle()
  expect(query.fetches()).toBe(1)
  r.stop()
})

test("after a dropped socket, every query refetches once the next watch begins", async () => {
  jest.useFakeTimers()
  const r = await connectedWithQueries()
  const query = mounted(["key:/posts/1"])
  await settle()
  r.socket().drop(1006)
  jest.advanceTimersByTime(60_000)
  await until(() => FakeSocket.all.length === 2, "reconnect")
  r.socket().welcome(SID_2)
  await until(() => r.socket().watches().length === 1, "watch on the new socket")
  await settle()
  expect(query.fetches()).toBe(1)
  ready(r, [[]])
  await until(() => query.fetches() === 2, "refetch under the new watch")
  query.off()
  r.stop()
})

test("a polled page refetches its live queries with it", async () => {
  jest.useFakeTimers()
  const r = rig()
  r.server.control.grant = false
  r.server.control.query = "keys"
  const query = mounted(["key:/posts/1"])
  r.socket().welcome()
  await until(() => r.server.loads.length === 1 && !r.router.snapshot().pending, "first load")
  await settle()
  expect(query.fetches()).toBe(1)
  jest.advanceTimersByTime(37_000)
  await until(() => query.fetches() === 2, "refetch with the poll")
  query.off()
  r.stop()
})

test("another viewer: every query client the page made drops what it held", async () => {
  Reflect.set(globalThis, "window", globalThis)
  try {
    const r = await connectedWithQueries()
    const client = createQueryClient({ now: () => Date.now() })
    client.setQueryData(["account"], "viewer-1's")
    const query = mounted(["key:/posts/1"], client)
    await settle()
    r.server.control.subject = "viewer-2"
    changed(r, "tag:/posts/1")
    await until(() => client.getQueryData(["account"]) === undefined, "cleared")
    // The mounted query loads again, for the new viewer.
    await until(() => query.fetches() >= 3, "refetched")
    query.off()
    r.stop()
  } finally {
    Reflect.deleteProperty(globalThis, "window")
  }
})

test("in development, a query key no grant holds is named once", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const r = rig()
    r.server.control.query = "keys"
    r.server.control.dev = true
    const query = mounted(["key:/posts/1", "key:nowhere"])
    r.socket().welcome()
    await until(() => r.socket().watches().length === 1, "watch")
    await until(() => warn.mock.calls.length === 1, "warning")
    expect(String(warn.mock.calls[0]?.[0])).toContain('"key:nowhere"')
    ready(r, [[]])
    changed(r, "tag:/posts/1")
    await until(() => r.socket().watches().length === 2, "rewatch")
    await settle()
    expect(warn).toHaveBeenCalledTimes(1)
    query.off()
    r.stop()
  } finally {
    warn.mockRestore()
  }
})

test("in development with queryKeys off, a query with live keys gets one warning; production none", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const off = rig()
    off.server.control.query = "off"
    const query = mounted(["key:/posts/1"])
    off.socket().welcome()
    await until(() => warn.mock.calls.length === 1, "warning")
    expect(String(warn.mock.calls[0]?.[0])).toContain("queryKeys off")
    query.off()
    off.stop()
    const production = rig()
    production.server.control.query = "keys"
    const quiet = mounted(["key:nowhere"])
    production.socket().welcome()
    await until(() => production.socket().watches().length === 1, "watch")
    await settle()
    expect(warn).toHaveBeenCalledTimes(1)
    quiet.off()
    production.stop()
  } finally {
    warn.mockRestore()
  }
})

test("a load whose query member is malformed is no live load: nothing is watched", async () => {
  const r = rig()
  r.server.control.query = "bad"
  r.socket().welcome()
  await until(() => r.server.loads.length === 1 && !r.router.snapshot().pending, "load")
  await settle()
  expect(r.socket().watches()).toEqual([])
  r.stop()
})

// --- Holes of a partially prerendered page --------------------------------------------------------

const CART = "B:cart:posts/[id]"
const PRICE = "B:price:posts/[id]"

/**
 * A live load endpoint for a page whose holes are hosts: every answer streams, its holes' fills and
 * then its grant as deferred lines the test sends, and the second keeps `price`.
 */
function holeServer() {
  const loads: (LoadBody & { readonly fill?: boolean })[] = []
  const streams: ReadableStreamDefaultController<Uint8Array>[] = []
  const fetch = async (_input: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body))
    loads.push(body)
    const n = loads.length
    const price =
      n === 1
        ? {
            name: "price",
            mode: "shared",
            status: "pending",
            ppr: true,
            fill: { __nifra_deferred: 1 },
          }
        : { name: "price", mode: "shared", status: "pending", ppr: true, kept: true }
    const head = {
      v: 1,
      data: { n },
      layoutData: [{ root: n }],
      retained: [],
      boundaries: {
        cart: {
          name: "cart",
          mode: "dynamic",
          status: "pending",
          ppr: true,
          fill: { __nifra_deferred: 0 },
        },
        price,
      },
      live: { __nifra_deferred: 2 },
    }
    const body$ = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(head)}\n`))
        streams.push(controller)
      },
    })
    return new Response(body$, { headers: { "content-type": "application/x-ndjson" } })
  }
  /** Send load `n`'s fills, then its grant, and end its stream. */
  const finish = (n: number): void => {
    const controller = streams[n - 1]
    if (controller === undefined) throw new Error(`no load ${n}`)
    const line = (value: unknown) =>
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`))
    line({ i: 0, v: { v: 1, html: `<p>cart ${n}</p>` } })
    if (n === 1) line({ i: 1, v: { v: 1, html: "<p>price</p>" } })
    line({
      i: 2,
      v: {
        subjects: ["viewer-1"],
        grant: `grant-${n}`,
        tags: { "tag:cart": [CART], "tag:price": [PRICE] },
        ttl: 600,
      },
    })
    controller.close()
  }
  return { fetch, loads, finish }
}

test("a page whose holes are hosts reloads them as fills; its grant follows them, and a reload keeps the holes the server kept", async () => {
  const server = holeServer()
  const client = liveClient({ fetch: server.fetch, layoutIdsOf })
  const hosts: BoundaryStates = {
    cart: { name: "cart", mode: "dynamic", status: "pending", ppr: true },
    price: { name: "price", mode: "shared", status: "pending", ppr: true },
  }
  const router = createClientRouter({
    patterns,
    initial: { ...initial(), boundaries: hosts },
    fetchData: client.fetchData,
  })
  const stop = client.attach(router)
  const socket = (): FakeSocket => {
    const last = FakeSocket.all.at(-1)
    if (last === undefined) throw new Error("no socket")
    return last
  }
  socket().welcome()
  await until(() => server.loads.length === 1 && !router.snapshot().pending, "first load")
  expect(server.loads[0]).toMatchObject({ retain: [], grants: [], fill: true })
  // The head is shown at once; the grant is still on its way, so nothing is watched or loaded again.
  expect(router.snapshot().data).toEqual({ n: 1 })
  await settle()
  expect(socket().watches()).toEqual([])
  expect(server.loads).toHaveLength(1)

  server.finish(1)
  await until(() => socket().watches().length === 1, "watch after the grant")
  expect(socket().lastWatch().grants).toEqual(["grant-1"])
  socket().deliver({ t: "ready", gen: socket().lastWatch().gen, stale: [] })
  await settle()
  const price = router.snapshot().boundaries?.price

  socket().deliver({ t: "changed", tag: "tag:cart", spread: 0 })
  await until(() => server.loads.length === 2 && !router.snapshot().pending, "reload")
  expect(server.loads[1]).toMatchObject({
    retain: [ROOT, POST, PRICE],
    grants: ["grant-1"],
    fill: true,
  })
  // The kept hole is the state already on screen, so its host is left as it is.
  expect(router.snapshot().boundaries?.price).toBe(price)
  expect(router.snapshot().boundaries?.cart).toMatchObject({ ppr: true })
  server.finish(2)
  await until(() => socket().lastWatch().grants[0] === "grant-2", "rewatch")
  stop()
})
