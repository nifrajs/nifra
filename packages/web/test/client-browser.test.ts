import { afterAll, beforeAll, expect, test } from "bun:test"
import { installForms, installHistory, signalHydrated } from "../src/client.ts"
import {
  type Blocker,
  closeBoundary,
  getBrowserNavigate,
  registerBlocker,
} from "../src/navigation.ts"
import type { ClientRouter, RouterState } from "../src/router.ts"

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
  #target = ""
  scrolled = 0
  parent: FakeElement | null = null

  constructor(tagName = "div") {
    this.tagName = tagName
  }

  // An accessor, as in a browser, so a form's named control can shadow it.
  get target(): string {
    return this.#target
  }

  set target(value: string) {
    this.#target = value
  }

  closest(selector: string): FakeElement | null {
    if (selector === "a") return this.tagName === "a" ? this : null
    const parts = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector)
    if (parts === null) return null
    const [, attribute = "", value] = parts
    for (let el: FakeElement | null = this; el !== null; el = el.parent) {
      const held = FakeElement.prototype.getAttribute.call(el, attribute)
      if (value === undefined ? held !== null : held === value) return el
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

  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }

  scrollIntoView(): void {
    this.scrolled++
  }
}

/** Its `method`/`action` are prototype accessors, as `target` is, so a named control can shadow them. */
class FakeFormElement extends FakeElement {
  #method = "post"
  #action = "http://example.test/submit"
  nativeSubmits = 0
  readonly nativeSubmitters: Array<FakeElement | null> = []
  /** The action attribute the browser would have read for each native post. */
  readonly nativeActions: Array<string | null> = []

  constructor() {
    super("form")
  }

  get method(): string {
    return this.#method
  }

  set method(value: string) {
    this.#method = value
  }

  get action(): string {
    return this.#action
  }

  set action(value: string) {
    this.#action = value
  }

  submit(): void {
    this.nativeSubmits++
  }

  /** Like the browser's: a submit event first, and the native post only if no listener prevents it. */
  requestSubmit(submitter: FakeElement | null = null): void {
    const event = fakeEvent(this, submitter)
    document.emit("submit", event)
    if (event.defaultPrevented) return
    this.nativeSubmits++
    this.nativeSubmitters.push(submitter)
    this.nativeActions.push(
      submitter?.hasAttribute("formaction")
        ? submitter.getAttribute("formaction")
        : FakeElement.prototype.getAttribute.call(this, "action"),
    )
  }
}

/** A submit button; `form*` hold what the browser's reflected properties would. */
class FakeButtonElement extends FakeElement {
  formMethod = ""
  formAction = ""
  formTarget = ""

  constructor(attributes: Record<string, string> = {}) {
    super("button")
    for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value)
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
    constructor(
      readonly form: FakeFormElement,
      readonly submitter: FakeElement | null = null,
    ) {}
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
    get protocol() {
      return new URL(locationState.origin).protocol
    },
    get host() {
      return new URL(locationState.origin).host
    },
    get href() {
      return `${locationState.origin}${locationState.pathname}${locationState.search}${locationState.hash}`
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

function fakeEvent(
  target: FakeElement,
  submitter: FakeElement | null = null,
): Event & {
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
    submitter,
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
  // installing numbers the document's first entry; what follows is the navigation's own
  expect(historyCalls).toEqual([["replace", { nifraIndex: 0 }]])
  historyCalls = []

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
  // installing numbers the document's first entry; what follows is the navigation's own
  expect(historyCalls).toEqual([["replace", { nifraIndex: 0 }]])
  historyCalls = []

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
  // installing numbers the document's first entry; what follows is the navigation's own
  expect(historyCalls).toEqual([["replace", { nifraIndex: 0 }]])
  historyCalls = []

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

test("a page on a native webview's own scheme soft-navigates its links and navigate() calls", async () => {
  resetBrowser()
  // Capacitor on iOS serves the app from a non-special scheme, whose `URL.origin` reads "null".
  locationState.origin = "capacitor://localhost"
  const { router, navigated } = makeRouter()
  const fallback: string[] = []
  const stop = installHistory(router, { fallback: (path) => fallback.push(path) })

  const click = fakeEvent(fakeAnchor("capacitor://localhost/about"))
  document.emit("click", click)
  await Bun.sleep(0)
  expect(click.defaultPrevented).toBe(true)
  expect(navigated).toEqual(["/about"])
  expect(locationState.pathname).toBe("/about")

  getBrowserNavigate()?.("/settings?tab=2")
  await Bun.sleep(0)
  expect(navigated).toEqual(["/about", "/settings?tab=2"])

  const otherScheme = fakeEvent(fakeAnchor("https://localhost/about"))
  document.emit("click", otherScheme)
  expect(otherScheme.defaultPrevented).toBe(false)
  getBrowserNavigate()?.("javascript:alert(1)")
  await Bun.sleep(0)
  expect(navigated).toEqual(["/about", "/settings?tab=2"])
  expect(fallback).toEqual([])
  stop()
})

test("an opaque or file: page leaves its links to the browser instead of swallowing them", async () => {
  for (const [origin, href] of [
    ["null", "capacitor://localhost/about"],
    ["file://", "file:///about"],
  ] as const) {
    resetBrowser()
    locationState.origin = origin
    const { router, navigated } = makeRouter()
    const stop = installHistory(router)
    const click = fakeEvent(fakeAnchor(href))
    document.emit("click", click)
    getBrowserNavigate()?.("/about")
    await Bun.sleep(0)
    expect(click.defaultPrevented).toBe(false)
    expect(navigated).toEqual([])
    expect(historyCalls).toEqual([])
    stop()
  }
})

test("a malformed programmatic target is rejected before an active blocker inspects it", () => {
  resetBrowser()
  const { router } = makeRouter()
  const stop = installHistory(router)
  // installing numbers the document's first entry; what follows is the navigation's own
  expect(historyCalls).toEqual([["replace", { nifraIndex: 0 }]])
  historyCalls = []
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
    snapshot: () => ({ pending: false, path: "/current" }),
  } as unknown as ClientRouter
  const stop = installForms(router)

  const form = new FakeFormElement()
  form.action = "http://example.test/submit?q=1"
  form.setAttribute("data-nifra-revalidate", "false")
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

test("controls named like form properties do not change how the form submits", async () => {
  resetBrowser()
  const submissions: string[] = []
  let reject: Error | undefined
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: installForms calls only match and submit
  const router = {
    match: (path: string) => (path === "/submit" ? { routeId: "submit", params: {} } : null),
    submit: async (path: string, _body: FormData) => {
      submissions.push(path)
      if (reject !== undefined) throw reject
    },
    snapshot: () => ({
      routeId: "submit",
      params: {},
      path: "/current",
      data: null,
      pending: false,
    }),
  } as ClientRouter
  const stop = installForms(router)
  const form = new FakeFormElement()
  // A browser resolves `form.<name>` to the control with that name before the form's own property.
  for (const name of ["method", "action", "target", "requestSubmit", "getAttribute", "closest"]) {
    Object.defineProperty(form, name, { value: new FakeElement("input") })
  }

  const event = fakeEvent(form)
  document.emit("submit", event)
  await Bun.sleep(0)
  expect(event.defaultPrevented).toBe(true)
  expect(submissions).toEqual(["/submit"])

  reject = new Error("offline")
  document.emit("submit", fakeEvent(form))
  await Bun.sleep(0)
  expect(form.nativeSubmits).toBe(1)
  stop()
})

test("an enhanced submit goes through its button: name and value, formaction, formmethod, formtarget", async () => {
  resetBrowser()
  const submissions: Array<{ readonly path: string; readonly submitter: unknown }> = []
  let reject: Error | undefined
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: installForms calls only match and submit
  const router = {
    match: (path: string) =>
      path === "/submit" || path === "/other" ? { routeId: "r", params: {} } : null,
    submit: async (path: string, body: FormData) => {
      submissions.push({ path, submitter: Reflect.get(body, "submitter") })
      if (reject !== undefined) throw reject
    },
    snapshot: () => ({ routeId: "r", params: {}, path: "/current", data: null, pending: false }),
  } as ClientRouter
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  const stop = installForms(router)
  const form = new FakeFormElement()

  // Its name=value is part of the body the router posts.
  const intent = new FakeButtonElement({ name: "intent", value: "delete" })
  document.emit("submit", fakeEvent(form, intent))
  await settle()
  expect(submissions).toEqual([{ path: "/submit", submitter: intent }])

  const elsewhere = new FakeButtonElement({ formaction: "/other" })
  elsewhere.formAction = "http://example.test/other"
  document.emit("submit", fakeEvent(form, elsewhere))
  await settle()
  expect(submissions.at(-1)?.path).toBe("/other")

  const viaGet = new FakeButtonElement({ formmethod: "get" })
  viaGet.formMethod = "get"
  const getEvent = fakeEvent(form, viaGet)
  document.emit("submit", getEvent)
  expect(getEvent.defaultPrevented).toBe(false)

  const newTab = new FakeButtonElement({ formtarget: "_blank" })
  newTab.formTarget = "_blank"
  const tabEvent = fakeEvent(form, newTab)
  document.emit("submit", tabEvent)
  expect(tabEvent.defaultPrevented).toBe(false)

  // Nothing reached the server: the native post goes through the same button.
  reject = new Error("offline")
  document.emit("submit", fakeEvent(form, intent))
  await settle()
  expect(form.nativeSubmitters).toEqual([intent])
  expect(submissions).toHaveLength(3)
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

// A router stub whose navigations under /photos/ open the `photo` intercept boundary over `/current`.
// With `held`, each navigation waits until its release is called.
function interceptingRouter(held?: (() => void)[]): {
  readonly router: ClientRouter
  readonly navigated: string[]
} {
  const navigated: string[] = []
  let subscriber: (() => void) | undefined
  const page: RouterState = {
    routeId: "page",
    params: {},
    path: "/current",
    data: null,
    pending: false,
  }
  let state = page
  const stub: Pick<ClientRouter, "match" | "navigate" | "prefetch" | "subscribe" | "snapshot"> = {
    match: (path) => ({ routeId: path, params: {} }),
    navigate: async (path) => {
      if (held !== undefined) await new Promise<void>((resolve) => held.push(resolve))
      navigated.push(path)
      state = path.startsWith("/photos/")
        ? { ...page, path, intercepted: { boundary: "photo", pagePath: "/current" } }
        : { ...page, path }
      subscriber?.()
    },
    prefetch: async () => {},
    subscribe: (listener) => {
      subscriber = listener
      return () => {
        subscriber = undefined
      }
    },
    snapshot: () => state,
  }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: installHistory calls only match, navigate, prefetch, subscribe and snapshot
  return { router: stub as ClientRouter, navigated }
}

test("a boundary opened over the page keeps its scroll, and closeBoundary goes back to the page's entry", async () => {
  resetBrowser()
  const { router, navigated } = interceptingRouter()
  const stop = installHistory(router)
  const click = async (href: string): Promise<void> => {
    document.emit("click", fakeEvent(fakeAnchor(`http://example.test${href}`)))
    await Bun.sleep(0)
  }

  await click("/photos/2")
  await click("/photos/3")
  expect(navigated).toEqual(["/photos/2", "/photos/3"])
  expect(scrollCalls).toEqual([])

  closeBoundary("cart") // not the boundary that is open
  expect(historyCalls.filter(([kind]) => kind === "go")).toEqual([])
  closeBoundary("photo")
  expect(historyCalls.at(-1)).toEqual(["go", -2])

  // The browser lands on the page's entry: the page restores the scroll it had.
  historyState = { nifraIndex: 0, nifraScroll: [5, 6] }
  locationState.pathname = "/current"
  windowHub.emit("popstate", new Event("popstate"))
  await Bun.sleep(0)
  expect(navigated.at(-1)).toBe("/current")
  expect(scrollCalls).toEqual([[5, 6]])

  // Forward into the boundary again: the entry it was opened from is the page's.
  historyState = { nifraIndex: 1 }
  locationState.pathname = "/photos/2"
  windowHub.emit("popstate", new Event("popstate"))
  await Bun.sleep(0)
  closeBoundary("photo")
  expect(historyCalls.at(-1)).toEqual(["go", -1])
  stop()
})

test("closeBoundary goes back to the page even when a second target was opened before the first settled", async () => {
  resetBrowser()
  // Each navigation stays pending until released, so the second click lands before the first settles.
  const settle: (() => void)[] = []
  const { router, navigated } = interceptingRouter(settle)
  const stop = installHistory(router)
  const click = async (href: string): Promise<void> => {
    document.emit("click", fakeEvent(fakeAnchor(`http://example.test${href}`)))
    await Bun.sleep(0)
  }
  await click("/photos/2")
  await click("/photos/3")
  settle.at(-1)?.()
  await Bun.sleep(0)
  expect(navigated).toEqual(["/photos/3"])
  closeBoundary("photo")
  expect(historyCalls.at(-1)).toEqual(["go", -2])
  stop()
})

test("a fragment link inside the boundary is counted, so closeBoundary still reaches the page", async () => {
  resetBrowser()
  const { router } = interceptingRouter()
  const stop = installHistory(router)
  const click = async (href: string): Promise<void> => {
    document.emit("click", fakeEvent(fakeAnchor(`http://example.test${href}`)))
    await Bun.sleep(0)
  }
  await click("/photos/2") // entry 1, over the page at entry 0
  // The browser handles `#comments` itself: it pushes an entry with no state, then fires popstate and
  // hashchange.
  historyState = null
  locationState.pathname = "/photos/2"
  locationState.hash = "#comments"
  windowHub.emit("popstate", new Event("popstate"))
  windowHub.emit("hashchange", new Event("hashchange"))
  await Bun.sleep(0)
  expect(historyCalls.at(-1)).toEqual(["replace", { nifraIndex: 2 }])
  locationState.hash = ""
  await click("/photos/3") // entry 3
  closeBoundary("photo")
  expect(historyCalls.at(-1)).toEqual(["go", -3])
  stop()
})

test("closeBoundary never goes back to a page entry a later push cut off", async () => {
  resetBrowser()
  const { router, navigated } = interceptingRouter()
  const stop = installHistory(router)
  const click = async (href: string): Promise<void> => {
    document.emit("click", fakeEvent(fakeAnchor(`http://example.test${href}`)))
    await Bun.sleep(0)
  }
  await click("/photos/2") // entry 1, over the page at entry 0
  await click("/about") // entry 2: the page is now here
  historyState = { nifraIndex: 1 }
  locationState.pathname = "/photos/2"
  windowHub.emit("popstate", new Event("popstate")) // back into entry 1
  await Bun.sleep(0)
  await click("/photos/3") // entry 2 again: the page's entry is gone
  await click("/photos/4") // entry 3
  const before = historyCalls.length
  closeBoundary("photo")
  await Bun.sleep(0)
  expect(historyCalls.slice(before).map(([kind]) => kind)).toEqual(["replace"])
  expect(navigated.at(-1)).toBe("/current")
  stop()
})

test("a boundary opened by replacing the page's entry closes by replacing its URL with the page's", async () => {
  resetBrowser()
  const { router, navigated } = interceptingRouter()
  const stop = installHistory(router)
  getBrowserNavigate()?.("/photos/4", { replace: true })
  await Bun.sleep(0)
  const before = historyCalls.length
  closeBoundary("photo")
  await Bun.sleep(0)
  expect(historyCalls.slice(before).map(([kind]) => kind)).toEqual(["replace"])
  expect(navigated.at(-1)).toBe("/current")
  stop()
  // Torn down: nothing left to close.
  closeBoundary("photo")
})

test("while a boundary holds a target, a form with no action posts to the route that rendered it", async () => {
  resetBrowser()
  const submissions: string[] = []
  let reject: Error | undefined
  let intercepted: { boundary: string; pagePath: string } | undefined = {
    boundary: "photo",
    pagePath: "/current?sort=new",
  }
  const stub: Pick<ClientRouter, "match" | "submit" | "snapshot"> = {
    match: (path) => ({ routeId: path, params: {} }),
    submit: async (path) => {
      submissions.push(path)
      if (reject !== undefined) throw reject
    },
    snapshot: () => {
      const state: RouterState = {
        routeId: "page",
        params: {},
        path: "/photos/2",
        data: null,
        pending: false,
      }
      return intercepted === undefined ? state : { ...state, intercepted }
    },
  }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: installForms calls only match, submit and snapshot
  const router = stub as ClientRouter
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  const stop = installForms(router)
  const submit = async (form: FakeFormElement, submitter: FakeElement | null = null) => {
    document.emit("submit", fakeEvent(form, submitter))
    await settle()
    return submissions.at(-1)
  }
  // The document URL is the target's, so that is what an unset action resolves to.
  const onPage = new FakeFormElement()
  onPage.action = "http://example.test/photos/2"
  expect(await submit(onPage)).toBe("/current?sort=new")

  const holder = new FakeElement("dialog")
  holder.setAttribute("data-nifra-boundary", "photo")
  const inBoundary = new FakeFormElement()
  inBoundary.action = "http://example.test/photos/2"
  inBoundary.parent = holder
  expect(await submit(inBoundary)).toBe("/photos/2")

  // A marker for another boundary nested inside the open one leaves the form with the open one.
  const nested = new FakeElement("section")
  nested.setAttribute("data-nifra-boundary", "cart")
  nested.parent = holder
  const inNested = new FakeFormElement()
  inNested.action = "http://example.test/photos/2"
  inNested.parent = nested
  expect(await submit(inNested)).toBe("/photos/2")

  const otherHolder = new FakeElement("aside")
  otherHolder.setAttribute("data-nifra-boundary", "cart")
  const inOther = new FakeFormElement()
  inOther.action = "http://example.test/photos/2"
  inOther.parent = otherHolder
  expect(await submit(inOther)).toBe("/current?sort=new")

  // An empty action is the document URL too; a named one is kept.
  const empty = new FakeFormElement()
  empty.setAttribute("action", " ")
  empty.action = "http://example.test/photos/2"
  expect(await submit(empty)).toBe("/current?sort=new")
  const named = new FakeFormElement()
  named.setAttribute("action", "/elsewhere")
  named.action = "http://example.test/elsewhere"
  expect(await submit(named)).toBe("/elsewhere")
  const viaButton = new FakeButtonElement({ formaction: "/other" })
  viaButton.formAction = "http://example.test/other"
  expect(await submit(onPage, viaButton)).toBe("/other")
  const blankButton = new FakeButtonElement({ formaction: "" })
  blankButton.formAction = "http://example.test/photos/2"
  expect(await submit(inBoundary, blankButton)).toBe("/photos/2")

  // Properties named by controls cannot steer it.
  const shadowed = new FakeFormElement()
  shadowed.action = "http://example.test/photos/2"
  shadowed.parent = holder
  for (const name of ["closest", "getAttribute", "setAttribute"]) {
    Object.defineProperty(shadowed, name, { value: new FakeElement("input") })
  }
  expect(await submit(shadowed)).toBe("/photos/2")

  // Nothing reached the server: the native post goes to the same route, not the document URL, and
  // the attribute is put back once it has been read.
  reject = new Error("offline")
  await submit(onPage)
  expect(onPage.nativeActions).toEqual(["http://example.test/current?sort=new"])
  expect(onPage.getAttribute("action")).toBeNull()
  await submit(inBoundary, blankButton)
  expect(inBoundary.nativeActions).toEqual(["http://example.test/photos/2"])
  expect(blankButton.getAttribute("formaction")).toBe("")
  reject = undefined

  // A GET form submits natively; one the page rendered is pointed at the page for that submission.
  const search = new FakeFormElement()
  search.method = "get"
  document.emit("submit", fakeEvent(search, null))
  expect(search.getAttribute("action")).toBe("http://example.test/current?sort=new")
  await Bun.sleep(1)
  expect(search.getAttribute("action")).toBeNull()
  const before = submissions.length
  search.setAttribute("action", "/search")
  document.emit("submit", fakeEvent(search, null))
  expect(search.getAttribute("action")).toBe("/search")
  expect(submissions.length).toBe(before)

  // No boundary open: the document URL, as always.
  intercepted = undefined
  const plain = new FakeFormElement()
  plain.action = "http://example.test/photos/2"
  expect(await submit(plain)).toBe("/photos/2")
  stop()
})
