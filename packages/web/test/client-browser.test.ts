import { afterAll, beforeAll, expect, test } from "bun:test"
import { installForms, installHistory, signalHydrated } from "../src/client.ts"
import { type Blocker, getBrowserNavigate, registerBlocker } from "../src/navigation.ts"
import type { ClientRouter } from "../src/router.ts"

type Listener = (event: Event) => void

class FakeEventHub {
  readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const fn =
      typeof listener === "function"
        ? (listener as Listener)
        : (event: Event) => listener.handleEvent(event)
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(fn)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") this.listeners.get(type)?.delete(listener as Listener)
  }

  emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  dispatchEvent(event: Event): boolean {
    this.emit(event.type, event)
    return true
  }
}

class FakeElement {
  readonly attrs = new Map<string, string>()
  readonly dataset: Record<string, string | undefined> = {}
  readonly tagName: string
  href = ""
  target = ""
  scrolled = 0
  parent: FakeElement | null = null

  constructor(tagName = "div") {
    this.tagName = tagName
  }

  closest(selector: string): FakeElement | null {
    if (selector === "a") return this.tagName === "a" ? this : null
    if (selector !== "[data-nifra-prefetch]") return null
    for (let el: FakeElement | null = this; el !== null; el = el.parent) {
      if (el.hasAttribute("data-nifra-prefetch")) return el
    }
    return null
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
    if (name.startsWith("data-")) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value
    }
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  scrollIntoView(): void {
    this.scrolled++
  }
}

class FakeFormElement extends FakeElement {
  method = "post"
  action = "http://example.test/submit"
  nativeSubmits = 0

  constructor() {
    super("form")
  }

  submit(): void {
    this.nativeSubmits++
  }
}

class FakeDocument extends FakeEventHub {
  readonly documentElement = new FakeElement("html")
  readonly anchors = new Map<string, FakeElement>()
  /** What a scan for `viewport`/`render` links finds. */
  prefetchLinks: FakeElement[] = []
  startViewTransition?: (callback: () => unknown) => {
    ready: Promise<unknown>
    finished: Promise<unknown>
    updateCallbackDone: Promise<unknown>
  }

  getElementById(id: string): FakeElement | null {
    return this.anchors.get(id) ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector === "a[data-nifra-prefetch],[data-nifra-prefetch] a" ? this.prefetchLinks : []
  }
}

type FakeIntersection = { readonly isIntersecting: boolean; readonly target: FakeElement }

class FakeIntersectionObserver {
  static last: FakeIntersectionObserver | undefined
  readonly observed: FakeElement[] = []
  disconnects = 0

  constructor(readonly callback: (entries: readonly FakeIntersection[]) => void) {
    FakeIntersectionObserver.last = this
  }

  observe(el: FakeElement): void {
    this.observed.push(el)
  }

  disconnect(): void {
    this.observed.length = 0
    this.disconnects++
  }

  /** The browser reporting `el` crossing into (or out of) view. */
  report(el: FakeElement, isIntersecting = true): void {
    this.callback([{ isIntersecting, target: el }])
  }
}

const slot = globalThis as unknown as Record<string, unknown>
const previous = new Map<string, { readonly had: boolean; readonly value: unknown }>()
const globals = [
  "document",
  "window",
  "history",
  "location",
  "Element",
  "HTMLFormElement",
  "FormData",
  "requestAnimationFrame",
  "scrollX",
  "scrollY",
  "IntersectionObserver",
] as const

let document: FakeDocument
let windowHub: FakeEventHub & { scrollTo(x: number, y: number): void }
let historyState: Record<string, unknown> | null
let locationState: {
  origin: string
  pathname: string
  search: string
  hash: string
  assigned: string[]
  replaced: string[]
}
let historyCalls: Array<readonly [string, unknown]>
let scrollCalls: Array<readonly [number, number]>

beforeAll(() => {
  for (const name of globals) {
    previous.set(name, { had: name in slot, value: slot[name] })
  }
  slot.Element = FakeElement
  slot.IntersectionObserver = FakeIntersectionObserver
  slot.HTMLFormElement = FakeFormElement
  slot.FormData = class {
    constructor(readonly form: FakeFormElement) {}
  }
  slot.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callback(0)
    return 1
  }
})

afterAll(() => {
  for (const name of globals) {
    const saved = previous.get(name)
    if (saved?.had) slot[name] = saved.value
    else delete slot[name]
  }
})

function resetBrowser(): void {
  document = new FakeDocument()
  scrollCalls = []
  windowHub = Object.assign(new FakeEventHub(), {
    scrollTo(x: number, y: number) {
      scrollCalls.push([x, y])
    },
  })
  historyState = null
  historyCalls = []
  locationState = {
    origin: "http://example.test",
    pathname: "/current",
    search: "",
    hash: "",
    assigned: [],
    replaced: [],
  }
  const updateLocation = (path: string): void => {
    const url = new URL(path, locationState.origin)
    locationState.pathname = url.pathname
    locationState.search = url.search
    locationState.hash = url.hash
  }
  slot.document = document
  slot.window = windowHub
  slot.location = {
    get origin() {
      return locationState.origin
    },
    get pathname() {
      return locationState.pathname
    },
    get search() {
      return locationState.search
    },
    get hash() {
      return locationState.hash
    },
    assign(path: string) {
      locationState.assigned.push(path)
    },
    replace(path: string) {
      locationState.replaced.push(path)
    },
  }
  slot.history = {
    scrollRestoration: "auto",
    get state() {
      return historyState
    },
    replaceState(state: Record<string, unknown>, _unused: string, path?: string) {
      historyState = state
      historyCalls.push(["replace", state])
      if (path !== undefined) updateLocation(path)
    },
    pushState(state: Record<string, unknown>, _unused: string, path: string) {
      historyState = state
      historyCalls.push(["push", state])
      updateLocation(path)
    },
    go(delta: number) {
      historyCalls.push(["go", delta])
    },
  }
  slot.scrollX = 12
  slot.scrollY = 34
}

function fakeEvent(target: FakeElement): Event & {
  defaultPrevented: boolean
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
} {
  let prevented = false
  return {
    target,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    get defaultPrevented() {
      return prevented
    },
    preventDefault() {
      prevented = true
    },
  } as unknown as Event & {
    defaultPrevented: boolean
    button: number
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
  }
}

// A minimal router stub for the blocker tests: records the paths it was asked to navigate.
function makeRouter(): { readonly router: ClientRouter; readonly navigated: string[] } {
  const navigated: string[] = []
  let subscriber: (() => void) | undefined
  const state = { pending: false }
  const router = {
    match: (path: string) => (path === "/outside" ? null : { routeId: path, params: {} }),
    navigate: async (path: string) => {
      navigated.push(path)
      subscriber?.()
    },
    prefetch: async () => {},
    subscribe: (listener: () => void) => {
      subscriber = listener
      return () => {
        subscriber = undefined
      }
    },
    snapshot: () => state,
  } as unknown as ClientRouter
  return { router, navigated }
}

function fakeAnchor(href: string): FakeElement {
  const anchor = new FakeElement("a")
  anchor.href = href
  anchor.closest = () => anchor
  return anchor
}

function fakeBeforeUnload(): BeforeUnloadEvent & {
  returnValue: string
  defaultPrevented: boolean
} {
  let prevented = false
  return {
    type: "beforeunload",
    returnValue: "unset",
    preventDefault() {
      prevented = true
    },
    get defaultPrevented() {
      return prevented
    },
  } as unknown as BeforeUnloadEvent & { returnValue: string; defaultPrevented: boolean }
}

test("history integration covers click, prefetch, fragments, popstate, fallback and teardown", async () => {
  resetBrowser()
  const navigated: string[] = []
  const prefetched: string[] = []
  let subscriber: (() => void) | undefined
  let rejectNext: Error | undefined
  const state = { pending: false }
  const router = {
    match: (path: string) => (path === "/outside" ? null : { routeId: path, params: {} }),
    navigate: async (path: string) => {
      navigated.push(path)
      if (rejectNext !== undefined) {
        const error = rejectNext
        rejectNext = undefined
        throw error
      }
      subscriber?.()
    },
    prefetch: async (path: string) => {
      prefetched.push(path)
    },
    subscribe: (listener: () => void) => {
      subscriber = listener
      return () => {
        subscriber = undefined
      }
    },
    snapshot: () => state,
  } as unknown as ClientRouter
  document.startViewTransition = (callback) => {
    void callback()
    const skipped = Promise.reject(new Error("skipped"))
    return { ready: skipped, finished: skipped, updateCallbackDone: skipped }
  }
  const fallback: string[] = []
  const stop = installHistory(router, { fallback: (path) => fallback.push(path) })

  const anchorTarget = new FakeElement("div")
  const anchor = new FakeElement("a")
  anchor.href = "http://example.test/docs?q=1#install"
  anchor.closest = () => anchor
  document.anchors.set("install", anchorTarget)

  document.emit("pointerover", fakeEvent(anchor))
  document.emit("focusin", fakeEvent(anchor))
  expect(prefetched).toEqual(["/docs?q=1", "/docs?q=1"])

  const click = fakeEvent(anchor)
  document.emit("click", click)
  await Bun.sleep(0)
  expect(click.defaultPrevented).toBe(true)
  expect(navigated).toContain("/docs?q=1")
  expect(historyCalls.map(([kind]) => kind)).toEqual(["replace", "push"])
  expect(anchorTarget.scrolled).toBe(1)

  const navigate = getBrowserNavigate()
  navigate?.("/replace", { replace: true })
  navigate?.(-1)
  await Bun.sleep(0)
  expect(historyCalls.some(([kind]) => kind === "go")).toBe(true)
  expect(scrollCalls).toContainEqual([0, 0])

  historyState = { nifraScroll: [7, 9] }
  locationState.pathname = "/back"
  windowHub.emit("popstate", new Event("popstate"))
  await Bun.sleep(0)
  expect(navigated).toContain("/back")
  expect(scrollCalls).toContainEqual([7, 9])

  delete document.startViewTransition
  navigate?.("/plain#%E0%A4")
  await Bun.sleep(0)
  expect(scrollCalls).toContainEqual([0, 0])

  rejectNext = new Error("offline")
  const failing = new FakeElement("a")
  failing.href = "http://example.test/fail"
  document.emit("click", fakeEvent(failing))
  await Bun.sleep(0)
  expect(fallback).toEqual(["/fail"])

  // A redirect the router cannot follow replaces the entry with its target.
  rejectNext = Object.assign(new Error("redirected"), { redirectTo: "https://id.example/auth" })
  const guarded = new FakeElement("a")
  guarded.href = "http://example.test/guarded"
  document.emit("click", fakeEvent(guarded))
  await Bun.sleep(0)
  expect(fallback).toEqual(["/fail"])
  expect(locationState.replaced).toEqual(["https://id.example/auth"])

  // A `javascript:` target would run in this page; the link loads as a document instead.
  rejectNext = Object.assign(new Error("redirected"), { redirectTo: " JavaScript:alert(1)" })
  document.emit("click", fakeEvent(guarded))
  await Bun.sleep(0)
  expect(locationState.replaced).toEqual(["https://id.example/auth"])
  expect(fallback).toEqual(["/fail", "/guarded"])

  // Back/forward that fails reloads the whole entry, query included.
  rejectNext = new Error("offline")
  locationState.pathname = "/list"
  locationState.search = "?page=2"
  windowHub.emit("popstate", new Event("popstate"))
  await Bun.sleep(0)
  expect(fallback).toEqual(["/fail", "/guarded", "/list?page=2"])
  locationState.search = ""

  const samePage = new FakeElement("a")
  locationState.pathname = "/back"
  samePage.href = "http://example.test/back#section"
  const samePageClick = fakeEvent(samePage)
  document.emit("click", samePageClick)
  expect(samePageClick.defaultPrevented).toBe(false)

  stop()
  expect(getBrowserNavigate()).toBeUndefined()
})

test("the address bar follows a redirect the router follows", async () => {
  resetBrowser()
  let state: { pending: boolean; pendingPath?: string } = { pending: false }
  let subscriber: (() => void) | undefined
  const publish = (next: typeof state): void => {
    state = next
    subscriber?.()
  }
  const router = {
    match: (path: string) => ({ routeId: path, params: {} }),
    navigate: async (path: string) => {
      publish({ pending: true, pendingPath: path })
      if (path === "/guarded") publish({ pending: true, pendingPath: "/login" })
      publish({ pending: false })
    },
    prefetch: async () => {},
    subscribe: (listener: () => void) => {
      subscriber = listener
      return () => {
        subscriber = undefined
      }
    },
    snapshot: () => state,
  } as unknown as ClientRouter
  const stop = installHistory(router)

  // A navigation's redirect replaces the entry it pushed, keeping the link's fragment.
  const link = new FakeElement("a")
  link.href = "http://example.test/guarded#intro"
  document.emit("click", fakeEvent(link))
  await Bun.sleep(0)
  expect(locationState.pathname + locationState.search + locationState.hash).toBe("/login#intro")
  expect(historyCalls.map(([kind]) => kind)).toEqual(["replace", "push", "replace"])
  expect(historyState).toMatchObject({ nifraIndex: 1 })

  // A form post's redirect adds an entry and scrolls to the top.
  historyCalls = []
  scrollCalls = []
  publish({ pending: true, pendingPath: "/done?ok=1" })
  publish({ pending: false })
  expect(locationState.pathname + locationState.search).toBe("/done?ok=1")
  expect(historyCalls.map(([kind]) => kind)).toEqual(["replace", "push"])
  expect(historyState).toMatchObject({ nifraIndex: 2 })
  expect(scrollCalls).toEqual([[0, 0]])

  // One that lands back on the page it was posted from adds nothing.
  historyCalls = []
  publish({ pending: true, pendingPath: "/done?ok=1" })
  publish({ pending: false })
  expect(historyCalls).toEqual([])
  stop()
})

// A router stub that records prefetches; `settle` is the store announcing a settled state.
function makePrefetchRouter(): {
  readonly router: ClientRouter
  readonly prefetched: string[]
  readonly state: { pending: boolean }
  readonly settle: () => void
} {
  const prefetched: string[] = []
  let subscriber: (() => void) | undefined
  const state = { pending: false }
  const router = {
    match: (path: string) => (path === "/outside" ? null : { routeId: path, params: {} }),
    navigate: async () => {},
    prefetch: async (path: string) => {
      prefetched.push(path)
    },
    subscribe: (listener: () => void) => {
      subscriber = listener
      return () => {
        subscriber = undefined
      }
    },
    snapshot: () => state,
  } as unknown as ClientRouter
  return { router, prefetched, state, settle: () => subscriber?.() }
}

// A link, its own `data-nifra-prefetch` (if any), and an ancestor's (if any).
function prefetchLink(href: string, mode?: string, ancestorMode?: string): FakeElement {
  const anchor = new FakeElement("a")
  anchor.href = href
  if (mode !== undefined) anchor.setAttribute("data-nifra-prefetch", mode)
  if (ancestorMode !== undefined) {
    const nav = new FakeElement("nav")
    nav.setAttribute("data-nifra-prefetch", ancestorMode)
    anchor.parent = nav
  }
  return anchor
}

test("data-nifra-prefetch=none on a link or an ancestor stops hover and focus prefetch", () => {
  resetBrowser()
  const { router, prefetched } = makePrefetchRouter()
  const stop = installHistory(router)
  document.emit("pointerover", fakeEvent(prefetchLink("http://example.test/a", "none")))
  document.emit("focusin", fakeEvent(prefetchLink("http://example.test/b", undefined, "none")))
  expect(prefetched).toEqual([])
  // The nearest attribute wins: a link opts back in under an ancestor that opted out.
  document.emit("pointerover", fakeEvent(prefetchLink("http://example.test/c", "intent", "none")))
  // An unknown value is the default.
  document.emit("focusin", fakeEvent(prefetchLink("http://example.test/d", "hover")))
  expect(prefetched).toEqual(["/c", "/d"])
  // The page on screen has nothing to warm.
  document.emit("pointerover", fakeEvent(prefetchLink("http://example.test/current")))
  expect(prefetched).toEqual(["/c", "/d"])
  stop()
})

test("render links warm when history is installed and each time the router settles", () => {
  resetBrowser()
  const { router, prefetched, state, settle } = makePrefetchRouter()
  document.prefetchLinks = [
    prefetchLink("http://example.test/pricing", "render"),
    prefetchLink("http://example.test/docs", undefined, "render"),
    prefetchLink("http://example.test/current", "render"), // the page on screen
    prefetchLink("http://example.test/outside", "render"), // not an app route
    prefetchLink("http://example.test/later", "intent", "render"), // the nearest wins
  ]
  const stop = installHistory(router)
  expect(prefetched).toEqual(["/pricing", "/docs"])

  document.prefetchLinks = [prefetchLink("http://example.test/blog?page=2#top", "render")]
  state.pending = true
  settle() // a navigation in flight: the old page is still up
  expect(prefetched).toEqual(["/pricing", "/docs"])
  state.pending = false
  settle()
  expect(prefetched).toEqual(["/pricing", "/docs", "/blog?page=2"])
  stop()
})

test("viewport links warm as they scroll into view; a settle looks again and teardown stops it", () => {
  resetBrowser()
  FakeIntersectionObserver.last = undefined
  const { router, prefetched, settle } = makePrefetchRouter()
  const next = prefetchLink("http://example.test/next", "viewport")
  const listed = prefetchLink("http://example.test/list", undefined, "viewport")
  document.prefetchLinks = [next, listed]
  const stop = installHistory(router)
  const seen = FakeIntersectionObserver.last as FakeIntersectionObserver | undefined
  if (seen === undefined) throw new Error("no IntersectionObserver was created")
  expect(seen.observed).toEqual([next, listed])
  expect(prefetched).toEqual([])

  seen.report(next, false) // leaving the viewport warms nothing
  expect(prefetched).toEqual([])
  seen.report(next)
  expect(prefetched).toEqual(["/next"])

  document.prefetchLinks = [listed]
  settle()
  expect(seen.disconnects).toBe(1)
  expect(seen.observed).toEqual([listed])
  stop()
  expect(seen.disconnects).toBe(2)
})

test("a page with no viewport links creates no IntersectionObserver", () => {
  resetBrowser()
  FakeIntersectionObserver.last = undefined
  const { router } = makePrefetchRouter()
  document.prefetchLinks = [prefetchLink("http://example.test/pricing", "render")]
  const stop = installHistory(router)
  expect(FakeIntersectionObserver.last).toBeUndefined()
  stop()
})

test("programmatic navigation hard-loads unmatched paths but rejects cross-origin targets", async () => {
  resetBrowser()
  const { router, navigated } = makeRouter()
  const fallback: string[] = []
  const stop = installHistory(router, { fallback: (path) => fallback.push(path) })

  getBrowserNavigate()?.("/outside")
  await Bun.sleep(0)

  expect(fallback).toEqual(["/outside"])
  expect(navigated).toEqual([])
  expect(historyCalls).toEqual([])
  expect(locationState.pathname).toBe("/current")

  getBrowserNavigate()?.("javascript:alert(1)")
  expect(fallback).toEqual(["/outside"])
  expect(historyCalls).toEqual([])

  getBrowserNavigate()?.("https://elsewhere.test/page")
  expect(fallback).toEqual(["/outside"])
  expect(historyCalls).toEqual([])
  stop()
})

test("a malformed programmatic target is rejected before an active blocker inspects it", () => {
  resetBrowser()
  const { router } = makeRouter()
  const stop = installHistory(router)
  const unregister = registerBlocker(
    () => false,
    () => {},
  )

  expect(() => getBrowserNavigate()?.("http://[")).not.toThrow()
  expect(historyCalls).toEqual([])
  expect(locationState.assigned).toEqual([])

  unregister()
  stop()
})

test("form integration intercepts app POSTs, preserves revalidation choice and falls back natively", async () => {
  resetBrowser()
  const submissions: Array<{ readonly path: string; readonly revalidate: boolean }> = []
  let reject: Error | undefined
  const router = {
    match: (path: string) => (path === "/submit" ? { routeId: "submit", params: {} } : null),
    submit: async (path: string, _form: FormData, options: { revalidate: boolean }) => {
      submissions.push({ path, revalidate: options.revalidate })
      if (reject !== undefined) throw reject
    },
  } as unknown as ClientRouter
  const stop = installForms(router)

  const form = new FakeFormElement()
  form.action = "http://example.test/submit?q=1"
  form.dataset.nifraRevalidate = "false"
  const first = fakeEvent(form)
  document.emit("submit", first)
  await Bun.sleep(0)
  expect(first.defaultPrevented).toBe(true)
  expect(submissions).toEqual([{ path: "/submit?q=1", revalidate: false }])

  reject = new Error("offline")
  document.emit("submit", fakeEvent(form))
  await Bun.sleep(0)
  expect(form.nativeSubmits).toBe(1)

  // The action ran, then refreshing the page redirected: load the target, never post again.
  reject = Object.assign(new Error("redirected"), { redirectTo: "/login" })
  document.emit("submit", fakeEvent(form))
  await Bun.sleep(0)
  expect(form.nativeSubmits).toBe(1)
  expect(locationState.assigned).toEqual(["/login"])

  form.method = "get"
  const getSubmit = fakeEvent(form)
  document.emit("submit", getSubmit)
  expect(getSubmit.defaultPrevented).toBe(false)
  stop()
})

test("signalHydrated marks the document and dispatches once", () => {
  resetBrowser()
  let signals = 0
  document.addEventListener("nifra:hydrated", () => signals++)
  signalHydrated()
  signalHydrated()
  expect(document.documentElement.hasAttribute("data-nifra-hydrated")).toBe(true)
  expect(signals).toBe(1)
})

test("useBlocker holds link clicks and programmatic navigate; proceed/reset resolve them", async () => {
  resetBrowser()
  const { router, navigated } = makeRouter()
  const stop = installHistory(router)

  let dirty = true
  const seen: Array<{ readonly current: string; readonly next: string }> = []
  const states: Blocker[] = []
  const unregister = registerBlocker(
    ({ currentLocation, nextLocation }) => {
      seen.push({ current: currentLocation.pathname, next: nextLocation.pathname })
      return dirty
    },
    (b) => states.push(b),
  )

  // Point 1 - a link click is intercepted: native nav prevented, no soft-nav, and the guard arms with
  // the right from/to. `current` is where we are (/current); `next` is the link target.
  const click = fakeEvent(fakeAnchor("http://example.test/next"))
  document.emit("click", click)
  expect(click.defaultPrevented).toBe(true)
  expect(navigated).toEqual([])
  expect(states.at(-1)?.state).toBe("blocked")
  expect(seen.at(-1)).toEqual({ current: "/current", next: "/next" })

  // While the prompt is open, a second navigation is swallowed (not passed through, not re-armed).
  const other = fakeEvent(fakeAnchor("http://example.test/elsewhere"))
  document.emit("click", other)
  expect(other.defaultPrevented).toBe(true)
  expect(navigated).toEqual([])
  expect(states.map((b) => b.state)).toEqual(["blocked"])

  // proceed() replays exactly the held navigation, then the guard returns to idle for next time.
  states.at(-1)?.proceed?.()
  await Bun.sleep(0)
  expect(navigated).toEqual(["/next"])
  expect(states.map((b) => b.state)).toEqual(["blocked", "proceeding", "unblocked"])

  // Point 2 - a programmatic navigate goes through the same funnel; reset() cancels it (stay put).
  states.length = 0
  const navigate = getBrowserNavigate()
  navigate?.("/two")
  expect(navigated).toEqual(["/next"])
  expect(states.at(-1)?.state).toBe("blocked")
  states.at(-1)?.reset?.()
  expect(navigated).toEqual(["/next"])
  expect(states.map((b) => b.state)).toEqual(["blocked", "unblocked"])

  // A clean guard lets navigation flow straight through.
  dirty = false
  navigate?.("/three")
  await Bun.sleep(0)
  expect(navigated).toEqual(["/next", "/three"])

  unregister()
  stop()
})

test("useBlocker restore-then-prompts on back/forward, and proceed replays the pop", async () => {
  resetBrowser()
  const { router, navigated } = makeRouter()
  const stop = installHistory(router)

  let dirty = false
  const states: Blocker[] = []
  registerBlocker(
    () => dirty,
    (b) => states.push(b),
  )

  // Push to /page1 (index 1) while clean, so a back has an entry to return to.
  const navigate = getBrowserNavigate()
  navigate?.("/page1")
  await Bun.sleep(0)
  expect(navigated).toEqual(["/page1"])

  // Point 4 - a browser back to /current (index 0): the URL has ALREADY changed. The guard can't cancel
  // it, so it restores by reversing the move (history.go(+1)) and arms the prompt - no soft-nav happened.
  dirty = true
  historyState = { nifraIndex: 0 }
  locationState.pathname = "/current"
  windowHub.emit("popstate", new Event("popstate"))
  await Bun.sleep(0)
  expect(navigated).toEqual(["/page1"])
  expect(historyCalls).toContainEqual(["go", 1])
  expect(states.at(-1)?.state).toBe("blocked")

  // The restoring history.go(+1) fires its own popstate (back onto /page1) - it must be swallowed.
  historyState = { nifraIndex: 1 }
  locationState.pathname = "/page1"
  windowHub.emit("popstate", new Event("popstate"))
  await Bun.sleep(0)
  expect(navigated).toEqual(["/page1"])

  // proceed() re-issues history.go(-1) to redo the back...
  states.at(-1)?.proceed?.()
  expect(historyCalls).toContainEqual(["go", -1])
  // ...and the popstate it produces now flows (the guard is proceeding), landing on /current.
  historyState = { nifraIndex: 0 }
  locationState.pathname = "/current"
  windowHub.emit("popstate", new Event("popstate"))
  await Bun.sleep(0)
  expect(navigated).toEqual(["/page1", "/current"])
  expect(states.at(-1)?.state).toBe("unblocked")

  stop()
})

test("useBlocker reset on a back/forward stays put; the restoring popstate is swallowed", async () => {
  resetBrowser()
  const { router, navigated } = makeRouter()
  const stop = installHistory(router)

  let dirty = false
  const states: Blocker[] = []
  registerBlocker(
    () => dirty,
    (b) => states.push(b),
  )

  const navigate = getBrowserNavigate()
  navigate?.("/page1")
  await Bun.sleep(0)

  // Back to /current gets blocked and the URL is restored (history.go(+1)).
  dirty = true
  historyState = { nifraIndex: 0 }
  locationState.pathname = "/current"
  windowHub.emit("popstate", new Event("popstate"))
  await Bun.sleep(0)
  expect(states.at(-1)?.state).toBe("blocked")
  expect(historyCalls).toContainEqual(["go", 1])

  // reset() cancels: stay on /page1, guard idle.
  states.at(-1)?.reset?.()
  expect(states.at(-1)?.state).toBe("unblocked")

  // The restoring history.go(+1) fires its own popstate back onto /page1. It must be swallowed - no
  // phantom re-block and no navigation - even though the guard is still dirty. (This is what the
  // `reversing` flag buys: without it, this popstate re-arms the guard the user just dismissed.)
  historyState = { nifraIndex: 1 }
  locationState.pathname = "/page1"
  windowHub.emit("popstate", new Event("popstate"))
  await Bun.sleep(0)
  expect(states.at(-1)?.state).toBe("unblocked")
  expect(navigated).toEqual(["/page1"])

  stop()
})

test("useBlocker arms beforeunload only when it would block, and teardown unwires it", async () => {
  resetBrowser()
  const { router } = makeRouter()
  const stop = installHistory(router)

  let dirty = false
  const unregister = registerBlocker(
    () => dirty,
    () => {},
  )

  // Point 3 - a clean guard does NOT arm the native unload prompt.
  const clean = fakeBeforeUnload()
  windowHub.emit("beforeunload", clean)
  expect(clean.defaultPrevented).toBe(false)
  expect(clean.returnValue).toBe("unset")

  // A dirty guard calls preventDefault + sets returnValue - the browser then shows "Leave site?".
  dirty = true
  const armed = fakeBeforeUnload()
  windowHub.emit("beforeunload", armed)
  expect(armed.defaultPrevented).toBe(true)
  expect(armed.returnValue).toBe("")

  // A native close/reload while an in-app confirmation is already open must remain protected too.
  // The browser can dispatch beforeunload at any point; an active blocker is evidence of unsaved state,
  // not a reason to suppress the native prompt.
  getBrowserNavigate()?.("/two")
  const whileBlocked = fakeBeforeUnload()
  windowHub.emit("beforeunload", whileBlocked)
  expect(whileBlocked.defaultPrevented).toBe(true)
  expect(whileBlocked.returnValue).toBe("")

  // With the guard unregistered but history still installed, unload finds no registration and stays quiet.
  unregister()
  const orphan = fakeBeforeUnload()
  windowHub.emit("beforeunload", orphan)
  expect(orphan.defaultPrevented).toBe(false)

  // Teardown unwires the listener and clears the bridge: registerBlocker returns a no-op unregister
  // (calling it is safe) and the guard never fires again.
  stop()
  const noop = registerBlocker(
    () => true,
    () => {},
  )
  expect(noop).toBeTypeOf("function")
  noop()
  const afterStop = fakeBeforeUnload()
  windowHub.emit("beforeunload", afterStop)
  expect(afterStop.defaultPrevented).toBe(false)
})
