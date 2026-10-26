/**
 * A store the browser keeps past one call must not show one visitor's data to the next. The router's
 * warmed pages once outlived a sign-out, so a sign-in without a reload showed the next visitor the
 * previous one's prefetched page: a Map nothing cleared when the visitor changed.
 *
 * Every Map, Set, WeakMap and WeakSet that outlives a call in the modules a page loads is enrolled
 * here. A store of visitor data names the proof that an identity change keeps that data from the
 * next visitor: a two-visitor scenario below, or a test elsewhere. Any other store says why it holds
 * nothing a later visitor sees. A new store, or an entry whose store is gone, fails until someone
 * decides which it is. A scenario still open runs as failing, so the fix that closes it fails here
 * until its entry moves out of OPEN.
 *
 * Scenarios only read back through the paths someone wrote down. The sweep below calls every function
 * a page can reach on a module's client and the handles it hands out, so a new function, or a module
 * of visitor data no surface reaches, fails until it is swept or says why not.
 */
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { createClientRouter, createQueryClient, identityChanged } from "@nifrajs/web/client"
import ts from "typescript"

const ROOT = join(import.meta.dir, "..", "..", "..")

/** What a page loads in the browser: these entry points and every module they import. */
const ENTRIES: readonly (readonly [string, readonly string[]])[] = [
  [
    "web",
    [
      "client",
      "keep-alive",
      "live-client",
      "islands",
      "islands/swap",
      "forms",
      "vitals",
      "fn-state",
      "internal/query-runtime",
      "internal/fetcher-runtime",
      "internal/hole-runtime",
      "internal/loading-runtime",
      "internal/matches-runtime",
      "server-components/client",
      "service-worker",
    ],
  ],
  ...["web-react", "web-preact", "web-solid", "web-svelte", "web-vue"].map(
    (adapter) =>
      [
        adapter,
        [
          "client",
          "keep-alive",
          "fetcher",
          "router",
          "query",
          "await",
          ...(adapter === "web-react" ? ["island"] : []),
          "fn",
          "server-components/client",
        ],
      ] as const,
  ),
  ["web-vanilla", ["."]],
  ["client", ["."]],
  ["island-trigger", ["."]],
]

/** The source file a package subpath resolves to under Bun, or undefined for one that ships none. */
function exportOf(pkg: string, subpath: string): unknown {
  const manifest: { exports?: Record<string, unknown> } = JSON.parse(
    readFileSync(join(ROOT, "packages", pkg, "package.json"), "utf8"),
  )
  return manifest.exports?.[subpath === "." ? "." : `./${subpath}`]
}

function sourceOf(pkg: string, subpath: string): string | undefined {
  const target = exportOf(pkg, subpath)
  const path =
    typeof target === "string"
      ? target
      : typeof target === "object" && target !== null
        ? Reflect.get(target, "bun")
        : undefined
  return typeof path === "string" && /\.tsx?$/.test(path)
    ? join(ROOT, "packages", pkg, path)
    : undefined
}

function resolveImport(from: string, specifier: string): string | undefined {
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(from), specifier)
    return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(
      (candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate),
    )
  }
  const scoped = /^@nifrajs\/([^/]+)(?:\/(.+))?$/.exec(specifier)
  return scoped === null ? undefined : sourceOf(scoped[1] ?? "", scoped[2] ?? ".")
}

/** A store's binding: the variable, property or assignment target it is made for. */
function bindingOf(node: ts.Node, source: ts.SourceFile): string {
  for (let at = node.parent; !ts.isFunctionLike(at) && !ts.isSourceFile(at); at = at.parent) {
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text
    if (ts.isPropertyDeclaration(at) || ts.isPropertyAssignment(at)) return at.name.getText(source)
    if (
      ts.isBinaryExpression(at) &&
      [
        ts.SyntaxKind.EqualsToken,
        ts.SyntaxKind.QuestionQuestionEqualsToken,
        ts.SyntaxKind.BarBarEqualsToken,
      ].includes(at.operatorToken.kind)
    )
      return at.left.getText(source)
    if (ts.isStatement(at)) break
  }
  return "<expr>"
}

function nameOf(fn: ts.Node, source: ts.SourceFile): string | undefined {
  const named = Reflect.get(fn, "name")
  if (named !== undefined && ts.isIdentifier(named)) return named.text
  const parent = fn.parent
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.initializer === fn
  )
    return parent.name.getText(source)
  return undefined
}

/** The nearest named function or class a store is made in. */
function ownerOf(node: ts.Node, source: ts.SourceFile): string {
  for (let at = node.parent; !ts.isSourceFile(at); at = at.parent) {
    if (ts.isFunctionLike(at)) {
      const name = nameOf(at, source)
      if (name !== undefined) return name
    }
    if (ts.isClassDeclaration(at) && at.name !== undefined) return at.name.text
  }
  return "<module>"
}

/**
 * A store a function makes and only reads or writes in place is gone when the call returns. One that
 * a nested function captures, that is passed on, returned or stored on an object outlives it.
 */
function outlivesCall(node: ts.NewExpression): boolean {
  let fn: ts.Node | undefined
  for (let at = node.parent; !ts.isSourceFile(at); at = at.parent)
    if (ts.isFunctionLike(at) || ts.isClassLike(at)) {
      fn = at
      break
    }
  if (fn === undefined || ts.isClassLike(fn)) return true
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const name = parent.name.text
    let escapes = false
    const visit = (at: ts.Node, nested: boolean): void => {
      if (escapes) return
      if (ts.isIdentifier(at) && at.text === name && at !== parent.name) {
        const use = at.parent
        const inPlace =
          (ts.isPropertyAccessExpression(use) && use.expression === at) ||
          (ts.isForOfStatement(use) && use.expression === at) ||
          ts.isSpreadElement(use)
        if (nested || !inPlace) escapes = true
      }
      ts.forEachChild(at, (child) => visit(child, nested || ts.isFunctionLike(child)))
    }
    const body = Reflect.get(fn, "body")
    if (body !== undefined) visit(body, false)
    return escapes
  }
  if (ts.isSpreadElement(parent) || ts.isForOfStatement(parent)) return false
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return false
  return true
}

const WRITES = new Set(["add", "set", "delete", "clear"])

/**
 * The bindings a file adds to, sets, deletes from or clears through: each receiver as written, and
 * the property it ends in, so a store kept on an object counts when written as `node.children`.
 */
function written(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WRITES.has(node.expression.name.text)
    ) {
      const receiver = node.expression.expression
      names.add(receiver.getText(source))
      if (ts.isPropertyAccessExpression(receiver)) names.add(receiver.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

interface Module {
  readonly imports: readonly string[]
  /** `binding@owner`, or the bare binding for one made at module level. */
  readonly stores: readonly string[]
}

function moduleOf(file: string, text: string): Module {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const writes = written(source)
  const imports: string[] = []
  const stores: string[] = []
  const follow = (specifier: ts.Expression | undefined): void => {
    if (specifier !== undefined && ts.isStringLiteral(specifier)) imports.push(specifier.text)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true)
      follow(node.moduleSpecifier)
    else if (ts.isExportDeclaration(node) && !node.isTypeOnly) follow(node.moduleSpecifier)
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      follow(node.arguments[0])
    else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["Map", "Set", "WeakMap", "WeakSet"].includes(node.expression.text) &&
      outlivesCall(node)
    ) {
      const binding = bindingOf(node, source)
      const owner = ownerOf(node, source)
      // A table nothing writes to after it is made holds what the source wrote, never a visitor's.
      if (binding === "<expr>" || writes.has(binding) || writes.has(`this.${binding}`))
        stores.push(owner === "<module>" ? binding : `${binding}@${owner}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { imports, stores }
}

/** Every module a page loads, and the stores in each. */
function scan(): ReadonlyMap<string, readonly string[]> {
  const queue: string[] = []
  for (const [pkg, subpaths] of ENTRIES)
    for (const subpath of subpaths) {
      const file = sourceOf(pkg, subpath)
      if (file !== undefined) queue.push(file)
    }
  const stores = new Map<string, readonly string[]>()
  while (queue.length > 0) {
    const file = queue.shift() ?? ""
    const at = relative(ROOT, file)
    if (stores.has(at)) continue
    const module = moduleOf(file, readFileSync(file, "utf8"))
    stores.set(at, module.stores)
    for (const specifier of module.imports) {
      const target = resolveImport(file, specifier)
      if (target !== undefined) queue.push(target)
    }
  }
  return stores
}

// What a later visitor would see, as one visitor leaves the page for another.
interface Visit {
  /** The visitor the app's loaders and fetches answer for; `between` is one a page passes through on
   * its way to the second. */
  who: "first" | "between" | "second"
  /** The visitor the next change brings, the second unless set. */
  next?: Visit["who"]
  /** Visitor changes so far. */
  changes?: number
  /** The server the sweep's loads go to; a scenario's are answered as asked. */
  server?: Server
}

type Change = (visit: Visit) => Promise<void>

/** The visitor changes, and the server answers every load asked from here on as the sweep set it. */
function becomeNext(visit: Visit): void {
  visit.who = visit.next ?? "second"
  visit.changes = (visit.changes ?? 0) + 1
  if (visit.server !== undefined) visit.server.mode = visit.server.next
}

/** Sets the epoch cookie, as a response or another tab does. */
function setEpoch(value: string): void {
  const document: unknown = Reflect.get(globalThis, "document")
  if (typeof document === "object" && document !== null)
    Reflect.set(document, "cookie", `nifra-epoch=${value}`)
}

const pages = [
  { routeId: "index", pattern: "/" },
  { routeId: "me", pattern: "/me" },
  { routeId: "warm", pattern: "/warm" },
  { routeId: "cold", pattern: "/cold" },
]
const start = { routeId: "index", params: {}, path: "/", data: null, pending: false }
const routerFor = (visit: Visit) =>
  createClientRouter({
    patterns: pages,
    initial: start,
    fetchData: () => served(visit),
  })
const feed = {
  initialPageParam: 0,
  getNextPageParam: (_page: unknown, pages: readonly unknown[]) =>
    pages.length < 2 ? pages.length : undefined,
}

/** Each scenario loads as the first visitor, changes visitor, and returns what the second sees: through
 * what the page held from before the change, then through a fresh read. */
const SCENARIOS = [
  {
    id: "router-prefetch",
    title: "a page warmed for the first visitor is loaded again for the second",
    run: async (change: Change) => {
      const visit: Visit = { who: "first" }
      const router = routerFor(visit)
      await router.prefetch("/me")
      await change(visit)
      await router.navigate("/me")
      return router.snapshot().data
    },
  },
  {
    id: "router-revisit",
    title: "a page the first visitor left is loaded again when the second goes back to it",
    run: async (change: Change) => {
      const visit: Visit = { who: "first" }
      const router = routerFor(visit)
      await router.navigate("/me")
      await router.navigate("/")
      await change(visit)
      await router.navigate("/me")
      return router.snapshot().data
    },
  },
  {
    id: "router-fetcher",
    title: "a fetcher holds nothing it loaded for the first visitor",
    run: async (change: Change) => {
      const visit: Visit = { who: "first" }
      const router = routerFor(visit)
      const held = router.fetcher("account")
      await held.load("/me")
      await change(visit)
      return [held.snapshot().data, router.fetcher("account").snapshot().data]
    },
  },
  {
    id: "query",
    title: "a query cached for the first visitor is not what the second reads",
    run: async (change: Change) => {
      const visit: Visit = { who: "first" }
      const queries = createQueryClient({ now: () => 0, staleTime: Number.POSITIVE_INFINITY })
      const load = async () => ({ who: visit.who })
      const held = queries.query(["me"], load)
      await held.fetch()
      await change(visit)
      return [held.snapshot().data, await held.fetch(), queries.query(["me"], load).snapshot().data]
    },
  },
  {
    id: "query-infinite",
    title: "an infinite query's pages for the first visitor are not what the second reads",
    run: async (change: Change) => {
      const visit: Visit = { who: "first" }
      const queries = createQueryClient({ now: () => 0 })
      const load = async () => ({ who: visit.who })
      const held = queries.infiniteQuery(["feed"], load, feed)
      await held.fetch()
      await change(visit)
      return [
        held.snapshot().data,
        await held.fetchNextPage(),
        queries.infiniteQuery(["feed"], load, feed).snapshot().data,
      ]
    },
  },
  {
    id: "query-seed",
    title: "pages the document seeded for the first visitor are not what the second reads",
    run: async (change: Change) => {
      const visit: Visit = { who: "first" }
      const queries = createQueryClient({ now: () => 0 })
      queries.hydrate({
        queries: [],
        infiniteQueries: [
          { key: ["feed"], data: { pages: [{ who: "first" }], pageParams: [0] }, updatedAt: 0 },
        ],
      })
      await change(visit)
      return queries.infiniteQuery(["feed"], async () => ({ who: visit.who }), feed).snapshot().data
    },
  },
] as const

type ScenarioId = (typeof SCENARIOS)[number]["id"]

/** Visitor data an identity change does not drop yet, each with what the second visitor sees. */
const OPEN: Readonly<Partial<Record<ScenarioId, string>>> = {}

/** How a page hears that the visitor changed. */
const CHANGES: readonly (readonly [
  string,
  <T>(run: (change: Change) => Promise<T>) => Promise<T>,
])[] = [
  [
    "identityChanged()",
    (run) =>
      run(async (visit) => {
        becomeNext(visit)
        identityChanged()
      }),
  ],
  [
    "a new identity epoch cookie",
    async (run) => {
      const held = Object.getOwnPropertyDescriptor(globalThis, "document")
      const document = { cookie: "nifra-epoch=first" }
      Object.defineProperty(globalThis, "document", { value: document, configurable: true })
      try {
        // A response sets the cookie in a task of its own.
        return await run(async (visit) => {
          await Promise.resolve()
          becomeNext(visit)
          document.cookie = "nifra-epoch=second"
        })
      } finally {
        if (held === undefined) Reflect.deleteProperty(globalThis, "document")
        else Object.defineProperty(globalThis, "document", held)
      }
    },
  ],
]

/** Runs as a page: query clients a server builds per request are never adopted. */
async function asPage<T>(run: () => Promise<T>): Promise<T> {
  const held = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true })
  try {
    return await run()
  } finally {
    if (held === undefined) Reflect.deleteProperty(globalThis, "window")
    else Object.defineProperty(globalThis, "window", held)
  }
}

for (const scenario of SCENARIOS)
  for (const [change, through] of CHANGES) {
    const open = OPEN[scenario.id]
    const title = `${scenario.title}, after ${change}${open === undefined ? "" : ` - open: ${open}`}`
    const check = () =>
      asPage(async () => {
        const seen = await through(scenario.run)
        expect(JSON.stringify(seen) ?? "").not.toContain("first")
      })
    if (open === undefined) test(title, check)
    else test.failing(title, check)
  }

// The scenarios read back through paths someone chose, and a review found reads they missed. The
// sweep reads back through every function a page can reach on what it holds of a store: the store
// itself and each handle it hands out, kept with a subscriber and kept past its last one. After a
// visitor change, each call, and what the page holds once it settles, must come out the same whether
// the earlier loads answered for the first visitor or already for the second, and a call the change
// caught mid-load as that call made once the change landed. The change lands before the call or while
// its first load is in flight, or brings a visitor in between whom another tab's sign-in replaces, by
// its cookie alone, while the first load after the change is in flight; the server then answers, fails
// every load, or rotates the epoch on every response. A call's promise settles only once the page
// shows what the call ends with, and reports a load it waited on that failed, so a caller that awaits
// it sees the outcome; a call that posts and resolves shows the answer the server gave its POST; and
// a server that rotates the epoch on every response costs as many loads however long it rotates.

/** What the server does with a load asked once the visitor has changed. */
const SERVERS = ["answers", "fails every load", "rotates the epoch on every response"] as const

type ServerMode = (typeof SERVERS)[number]

// A rotating server stops after this many rotations, or twice as many: a page whose loads are bounded
// makes as many either way, and one that loads again on every rotation makes more the longer it goes.
const ROTATIONS = 20

interface Server {
  /** Unset until the visitor has changed, then {@link next}. */
  mode: ServerMode | undefined
  readonly next: ServerMode
  /** Loads asked once the visitor has changed. */
  loads: number
  /** Of those, the ones that failed. */
  failed: number
  rotations: number
  readonly maxRotations: number
  /** Holds the next load asked until it opens. */
  held: Gate | undefined
  /** A held load is waiting. */
  waiting: boolean
  closed: boolean
}

interface Gate {
  readonly opened: Promise<void>
  readonly open: () => void
}

function gate(): Gate {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

/** One load, answered as the server was when it was asked: a held load still in flight at the change
 * fares the same in both runs, and differs only in the visitor it answers for. */
async function served(visit: Visit): Promise<{ who: Visit["who"] }> {
  const server = visit.server
  if (server === undefined) return { who: visit.who }
  const asked = { who: visit.who, mode: server.mode }
  const held = server.held
  if (held !== undefined) {
    server.held = undefined
    server.waiting = true
    await held.opened
  }
  if (asked.mode === undefined || server.closed) return { who: asked.who }
  server.loads++
  if (asked.mode === "fails every load") {
    server.failed++
    throw new Error("the server is unavailable")
  }
  if (
    asked.mode === "rotates the epoch on every response" &&
    server.rotations < server.maxRotations
  ) {
    setEpoch(`r${++server.rotations}`)
    // To a page, a new epoch is a new visitor.
    visit.changes = (visit.changes ?? 0) + 1
  }
  return { who: asked.who }
}

/** Something a page holds of a store; `kind` names which arguments its functions are called with. */
interface Held {
  readonly name: string
  readonly kind: string
  readonly value: object
}

/** Several argument lists for one function, each swept on its own. */
class Each {
  constructor(readonly lists: readonly (readonly unknown[])[]) {}
}

const listsOf = (entry: readonly unknown[] | Each | undefined): readonly (readonly unknown[])[] =>
  entry === undefined ? [] : entry instanceof Each ? entry.lists : [entry]

interface Page {
  readonly held: readonly Held[]
  /** Arguments for each `kind.function`. */
  readonly calls: Readonly<Record<string, readonly unknown[] | Each>>
  /** For a call that returns a promise on a holder that shows nothing itself, what the call ends
   * with, or why it ends with nothing the page shows. Any other ends with what its holder shows. */
  readonly ends?: Readonly<Record<string, (() => unknown) | string>>
  /** Each call that resolves although a load failed while it was pending, with why that is its
   * outcome. Any other reports the failure. */
  readonly quiet?: Readonly<Record<string, string>>
  /** Each call that posts an action, with why it answers as its POST did when the change lands while
   * that POST is in flight, rather than as the call made after the change: no POST runs twice. */
  readonly posts?: Readonly<Record<string, string>>
  /** The server's answer to the last POST, unless the visitor changed after it was given: a call that
   * posts and resolves ends with it as its holder's `actionData`. */
  readonly answered?: () => unknown
  /** What the page shows once everything has settled, by part. It is read twice, a render and the
   * one after what that render started has landed: a new epoch cookie is seen at a read. */
  readonly settled: () => Readonly<Record<string, unknown>>
  readonly close?: () => void
}

interface Surface {
  readonly name: string
  /** The modules whose visitor data this surface reaches. */
  readonly files: readonly string[]
  /** Loads everything as `visit.who` and returns what the page holds. */
  readonly open: (visit: Visit) => Promise<Page>
}

interface Numbered {
  readonly who: string
  readonly n: number
}

/** A component showing `handle`: it renders after each change it hears, and a render reads the epoch
 * cookie, so a page that reloads on every new epoch keeps loading as long as the server rotates it. */
const mount = (handle: {
  subscribe: (listener: () => void) => () => void
  snapshot: () => unknown
}): (() => void) =>
  handle.subscribe(() => {
    setImmediate(() => handle.snapshot())
  })

// The first visitor's feed reaches further both ways than the second's.
const paged = {
  initialPageParam: 0,
  getNextPageParam: (last: Numbered) => (last.who === "first" && last.n === 0 ? 1 : undefined),
  getPreviousPageParam: (head: Numbered) => (head.who === "first" ? head.n - 1 : undefined),
}

const SURFACES: readonly Surface[] = [
  {
    name: "a query client",
    files: ["packages/web/src/query.ts"],
    open: async (visit) => {
      const queries = createQueryClient({ now: () => 0, staleTime: Number.POSITIVE_INFINITY })
      const me = () => served(visit)
      const page = async (n: number): Promise<Numbered> => ({ ...(await served(visit)), n })
      const query = queries.query(["me"], me)
      const mountedQuery = queries.query(["mine"], me)
      const feed = queries.infiniteQuery(["feed"], page, paged)
      const mountedFeed = queries.infiniteQuery(["mine", "feed"], page, paged)
      const mounted = [mount(mountedQuery), mount(mountedFeed)]
      await Promise.all([query.fetch(), mountedQuery.fetch(), feed.fetch(), mountedFeed.fetch()])
      await Promise.all([feed.fetchNextPage(), mountedFeed.fetchNextPage()])
      queries.hydrate({
        queries: [{ key: ["hydrated"], data: { who: visit.who }, updatedAt: 0 }],
        infiniteQueries: [
          {
            key: ["seeded"],
            data: { pages: [{ who: visit.who, n: 0 }], pageParams: [0] },
            updatedAt: 0,
          },
        ],
      })
      const handles = [query, mountedQuery, feed, mountedFeed]
      return {
        held: [
          { name: "client", kind: "client", value: queries },
          { name: "query", kind: "query", value: query },
          { name: "mounted query", kind: "query", value: mountedQuery },
          { name: "feed", kind: "feed", value: feed },
          { name: "mounted feed", kind: "feed", value: mountedFeed },
        ],
        calls: {
          "client.query": [["hydrated"], me],
          "client.infiniteQuery": [["seeded"], page, paged],
          "client.invalidateQueries": new Each([[["me"]], [["mine"]]]),
          "client.getQueryData": [["hydrated"]],
          "client.setQueryData": [["me"], (prev: unknown) => ({ prev })],
          "client.prefetchQuery": new Each([
            [["hydrated"], me],
            [["cold"], me],
          ]),
          "client.dehydrate": [],
          "client.hydrate": [{ queries: [] }],
          "client.clear": [],
          "query.snapshot": [],
          "query.subscribe": [() => {}],
          "query.fetch": [],
          "query.refetch": [],
          "feed.snapshot": [],
          "feed.subscribe": [() => {}],
          "feed.fetch": [],
          "feed.refetch": [],
          "feed.fetchNextPage": [],
          "feed.fetchPreviousPage": [],
          "feed.hasNextPage": [],
          "feed.hasPreviousPage": [],
        },
        ends: {
          "client.prefetchQuery": () =>
            [["hydrated"], ["cold"]].map((key) => queries.getQueryData(key)),
        },
        settled: () => ({
          handles: handles.map((handle) => handle.snapshot()),
          cache: queries.dehydrate(),
        }),
        close: () => {
          for (const unmount of mounted) unmount()
        },
      }
    },
  },
  {
    name: "the router",
    files: ["packages/web/src/router.ts"],
    open: async (visit) => {
      const fetching = Object.getOwnPropertyDescriptor(globalThis, "fetch")
      let posted: { readonly answer: unknown; readonly changes: number | undefined } | undefined
      Object.defineProperty(globalThis, "fetch", {
        value: async (_url: unknown, init?: RequestInit) => {
          const answer = await served(visit)
          if (init?.method === "POST") posted = { answer, changes: visit.changes }
          return Response.json(answer)
        },
        configurable: true,
        writable: true,
      })
      const router = routerFor(visit)
      await router.navigate("/me")
      await router.navigate("/")
      await router.prefetch("/warm")
      // Every page but the one on screen: visited, warmed and never loaded.
      const elsewhere = pages.filter((each) => each.pattern !== "/").map((each) => each.pattern)
      const fetcher = router.fetcher("account")
      const mounted = router.fetcher("mine")
      const shown = [mount(router), mount(mounted)]
      await Promise.all([fetcher.load("/me"), mounted.load("/me")])
      return {
        held: [
          { name: "router", kind: "router", value: router },
          { name: "fetcher", kind: "fetcher", value: fetcher },
          { name: "mounted fetcher", kind: "fetcher", value: mounted },
        ],
        calls: {
          "router.match": ["/me"],
          "router.snapshot": [],
          "router.subscribe": [() => {}],
          "router.navigate": new Each(elsewhere.map((path) => [path])),
          "router.submit": new Each(elsewhere.map((path) => [path, "x"])),
          "router.hydrate": [],
          "router.invalidate": [],
          "router.prefetch": new Each(elsewhere.map((path) => [path])),
          "router.fetcher": ["account"],
          "router.fetchers": [],
          "router.subscribeFetchers": [() => {}],
          "fetcher.snapshot": [],
          "fetcher.subscribe": [() => {}],
          "fetcher.load": new Each(elsewhere.map((path) => [path])),
          "fetcher.submit": new Each(elsewhere.map((path) => [path, "x"])),
        },
        ends: {
          "router.prefetch":
            "it warms a page for a later navigation; the page on screen is not its",
          "router.hydrate":
            "it runs the page's client loader once, at boot, and no page here has one: it loads nothing",
        },
        quiet: {
          "router.prefetch":
            "warming is best-effort: a failed one leaves the navigation to load the page",
          "fetcher.submit":
            "a submit answers for its own POST; the page's reload for a visitor change, and refreshing what shows a route it changed, are best-effort",
        },
        posts: {
          "router.submit": ACTION_ONCE,
          "fetcher.submit": ACTION_ONCE,
        },
        answered: () => (posted?.changes === visit.changes ? posted?.answer : undefined),
        settled: () => {
          // A page going as a document shows nothing more.
          const { actionData, ...page } = router.snapshot()
          const fetchers = router.fetchers().map((each) => each.snapshot())
          return {
            page: page.documentLoad === undefined ? page : { documentLoad: page.documentLoad },
            actionData,
            fetchers: fetchers.map(({ actionData: _, ...shown }) => shown),
            "fetcher actionData": fetchers.map((each) => each.actionData),
          }
        },
        close: () => {
          for (const unmount of shown) unmount()
          if (fetching === undefined) Reflect.deleteProperty(globalThis, "fetch")
          else Object.defineProperty(globalThis, "fetch", fetching)
        },
      }
    },
  },
]

const RELOADING =
  "the page on screen reloads in place: until the reload lands it shows as it was loaded, pending"
const ACTION_ONCE =
  "the action ran or failed as the server took its POST; posting it again for the visitor now here would run it twice"
const ANSWERED =
  "an action's answer stands: a visitor change while its POST is in flight is most often that POST's own sign-in or sign-out"

/** What still answers differently for what the first visitor loaded, each with why: a call's return
 * as `surface: held.function`, a settled part as `surface: part`. */
const SWEEP_OPEN: Readonly<Record<string, string>> = {
  "the router: router.snapshot": RELOADING,
  "the router: actionData": ANSWERED,
  "the router: fetcher actionData": ANSWERED,
}

/** A returned value as a page would use it: a handle by what it shows, a function as itself. */
function shape(value: unknown): unknown {
  if (typeof value === "function") return "function"
  const snapshot: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, "snapshot") : undefined
  return typeof snapshot === "function" ? { shows: Reflect.apply(snapshot, value, []) } : value
}

const flushed = () => new Promise((settle) => setImmediate(settle))

/** Turns until the server has had no new load for one; a page that loads on every rotation stops
 * once the server does. */
async function quiet(server: Server): Promise<void> {
  for (
    let seen = -1, turns = 0;
    seen !== server.loads && turns < 4 * server.maxRotations;
    turns++
  ) {
    seen = server.loads
    await flushed()
  }
}

const THROUGH = "before the call, and from another tab while the first load after it is in flight"
const TIMINGS = ["before the call", "while its first load is in flight", THROUGH] as const

type Parts = readonly (readonly [string, string])[]

interface Answer {
  readonly at: (typeof TIMINGS)[number]
  /** False when the change was to land during the call's first load and the call asked for none:
   * what it answered was read before the change. */
  readonly applies: boolean
  /** Why a call that returned a promise has nothing to check what it ended with against. */
  readonly unsaid: string | undefined
  readonly returned: string
  /** What the call ended with when its promise settled, and once the page had settled; none for a
   * call that returns no promise or ends with nothing the page shows. */
  readonly ends: readonly [string, string] | undefined
  readonly settled: Parts
  readonly loads: number
  /** It resolved although a load failed while it was pending. */
  readonly swallowed: boolean
  /** For a call that posts, the server's answer to its POST and the `actionData` its holder shows. */
  readonly posted: readonly [string, string] | undefined
  /** It was still pending when another tab's change landed. */
  readonly caught: boolean
}

const partsOf = (page: Page): Parts =>
  Object.entries(page.settled()).map(([part, value]): readonly [string, string] => [
    part,
    JSON.stringify(value) ?? "undefined",
  ])

/** Runs under a document, so a server can set the epoch cookie whichever way the visitor changes. */
async function withDocument<T>(run: () => Promise<T>): Promise<T> {
  const held = Object.getOwnPropertyDescriptor(globalThis, "document")
  if (held !== undefined) return run()
  Object.defineProperty(globalThis, "document", {
    value: { cookie: "nifra-epoch=first" },
    configurable: true,
  })
  try {
    return await run()
  } finally {
    Reflect.deleteProperty(globalThis, "document")
  }
}

/** What a call on `held` ends with, by `ends` or what the holder shows. */
function endsOf(page: Page, held: Held, fn: string): (() => unknown) | string {
  const declared = page.ends?.[`${held.kind}.${fn}`]
  if (declared !== undefined) return declared
  const snapshot: unknown = Reflect.get(held.value, "snapshot")
  return typeof snapshot === "function"
    ? () => Reflect.apply(snapshot, held.value, [])
    : `${held.kind} shows nothing itself; say in ends what ${held.kind}.${fn} ends with`
}

// A call quiet about a failure, or an answer that differs, in one change and timing only still is:
// `quiet` and SWEEP_OPEN entries are judged once every change and timing has run.
const seen = new Map<string, Set<string>>()
const seenAs = (what: string): Set<string> => {
  const all = seen.get(what) ?? new Set<string>()
  seen.set(what, all)
  return all
}
const quietedBy = (surface: string) => seenAs(`quieted by ${surface}`)
const compared = seenAs("compared")
const differed = seenAs("differed")
const sweeps = new Map<string, number>()

for (const surface of SURFACES) {
  for (const [change, through] of CHANGES)
    for (const timing of TIMINGS)
      test(`every call on what a page holds of ${surface.name}, after ${change} ${timing}, settles with what it ends with and answers the same whoever the earlier loads answered for, in a bounded number of loads`, async () => {
        sweeps.set(surface.name, (sweeps.get(surface.name) ?? 0) + 1)
        const listed = await asPage(() => surface.open({ who: "second" }))
        listed.close?.()
        const answer = (
          holder: string,
          fn: string,
          list: number,
          who: Visit["who"],
          mode: ServerMode,
          maxRotations = ROTATIONS,
          at: (typeof TIMINGS)[number] = timing,
        ) =>
          asPage(() =>
            withDocument(() =>
              through(async (changeVisitor): Promise<Answer> => {
                const server: Server = {
                  mode: undefined,
                  next: mode,
                  loads: 0,
                  failed: 0,
                  rotations: 0,
                  maxRotations,
                  held: undefined,
                  waiting: false,
                  closed: false,
                }
                const visit: Visit = { who }
                const page = await surface.open(visit)
                visit.server = server
                const asked = gate()
                try {
                  const changed = () => changeVisitor(visit)
                  const held = page.held.find((each) => each.name === holder)
                  if (held === undefined) throw new Error(`nothing held as ${holder}`)
                  const ends = endsOf(page, held, fn)
                  const read = () =>
                    typeof ends === "string" ? "" : (JSON.stringify(ends()) ?? "undefined")
                  if (at === THROUGH) visit.next = "between"
                  if (at !== "before the call") server.held = asked
                  if (at !== "while its first load is in flight") await changed()
                  let atSettle: string | undefined
                  let rotatedAtSettle = 0
                  let promised = false
                  let threw = false
                  let swallowed = false
                  let done = false
                  let pending: Promise<unknown>
                  const failedBefore = server.failed
                  try {
                    const args = listsOf(page.calls[`${held.kind}.${fn}`])[list] ?? []
                    const result: unknown = Reflect.apply(
                      Reflect.get(held.value, fn),
                      held.value,
                      args,
                    )
                    promised = result instanceof Promise
                    pending =
                      result instanceof Promise
                        ? result.then(
                            (value: unknown) => {
                              atSettle = read()
                              rotatedAtSettle = server.rotations
                              swallowed = server.failed > failedBefore
                              return shape(value)
                            },
                            (error: unknown) => {
                              atSettle = read()
                              rotatedAtSettle = server.rotations
                              threw = true
                              return { threw: String(error) }
                            },
                          )
                        : Promise.resolve(shape(result))
                  } catch (error) {
                    threw = true
                    pending = Promise.resolve({ threw: String(error) })
                  }
                  void pending.then(() => {
                    done = true
                  })
                  let applies = true
                  let caught = false
                  if (at !== "before the call") {
                    // The change lands once the call's first load waits, or not at all for a call
                    // that settles or keeps from loading for its turns.
                    for (let turn = 0; turn < 4 && !server.waiting && !done; turn++) await flushed()
                    applies = server.waiting
                    server.held = undefined
                    if (at === THROUGH) {
                      caught = !done
                      visit.who = "second"
                      visit.changes = (visit.changes ?? 0) + 1
                      setEpoch("another-tab")
                    } else await changed()
                    asked.open()
                  }
                  const returned = await pending
                  await quiet(server)
                  page.settled()
                  await quiet(server)
                  const answered =
                    threw || page.posts?.[`${held.kind}.${fn}`] === undefined
                      ? undefined
                      : page.answered?.()
                  const actionData = (): unknown => {
                    const shown: unknown = Reflect.apply(
                      Reflect.get(held.value, "snapshot"),
                      held.value,
                      [],
                    )
                    return typeof shown === "object" && shown !== null
                      ? Reflect.get(shown, "actionData")
                      : undefined
                  }
                  return {
                    at,
                    applies,
                    unsaid:
                      promised && typeof ends === "string" && ends.includes("say in ends")
                        ? ends
                        : undefined,
                    returned: JSON.stringify(returned) ?? "undefined",
                    // A rotation after it settled is a visitor change it does not answer for.
                    ends:
                      atSettle === undefined ||
                      typeof ends === "string" ||
                      server.rotations !== rotatedAtSettle
                        ? undefined
                        : [atSettle, read()],
                    settled: partsOf(page),
                    loads: server.loads,
                    swallowed,
                    posted:
                      answered === undefined
                        ? undefined
                        : [JSON.stringify(answered), JSON.stringify(actionData()) ?? "undefined"],
                    caught,
                  }
                } finally {
                  server.closed = true
                  asked.open()
                  page.close?.()
                }
              }),
            ),
          )
        const problems: string[] = []
        const swept = new Set<string>()
        const compare = (
          what: string,
          mode: ServerMode,
          first: string,
          second: string,
          label = what,
          against = "for the second visitor",
        ) => {
          const open = `${surface.name}: ${what}`
          compared.add(open)
          if (first === second) return
          if (SWEEP_OPEN[open] === undefined)
            problems.push(`${label}, server ${mode}: ${first} - ${against}: ${second}`)
          else differed.add(open)
        }
        for (const held of listed.held)
          for (const [fn, value] of Object.entries(held.value)) {
            if (typeof value !== "function") continue
            const call = `${held.kind}.${fn}`
            swept.add(call)
            if (listed.calls[call] === undefined) {
              problems.push(`${call}: not swept; give it arguments`)
              continue
            }
            const lists = listsOf(listed.calls[call])
            for (const [list, args] of lists.entries()) {
              const name = `${held.name}.${fn}`
              const named =
                lists.length > 1 ? `${name}(${JSON.stringify(args).slice(1, -1)})` : name
              for (const mode of SERVERS) {
                let first = await answer(held.name, fn, list, "first", mode)
                let second = await answer(held.name, fn, list, "second", mode)
                // One that loads for neither answered before the change. One that loads for only one
                // visitor settles at once for the other, so the change can land only before it there.
                if (!first.applies && !second.applies) continue
                if (!first.applies)
                  first = await answer(
                    held.name,
                    fn,
                    list,
                    "first",
                    mode,
                    ROTATIONS,
                    "before the call",
                  )
                if (!second.applies)
                  second = await answer(
                    held.name,
                    fn,
                    list,
                    "second",
                    mode,
                    ROTATIONS,
                    "before the call",
                  )
                const unsaid = first.unsaid ?? second.unsaid
                if (unsaid !== undefined && !problems.includes(unsaid)) problems.push(unsaid)
                compare(name, mode, first.returned, second.returned, named)
                for (const [index, [part, shown]] of first.settled.entries())
                  compare(
                    part,
                    mode,
                    shown,
                    second.settled[index]?.[1] ?? "",
                    `${part} after ${named}`,
                  )
                if (second.at === THROUGH) {
                  // Once another tab's change lands, nothing loaded for the visitor in between shows,
                  // and a call it caught mid-load does not return it. To a page, a server that rotates
                  // the epoch on every response signs in a visitor each time, and its loads stay bounded
                  // only by taking a change as their own: there only the load count is judged.
                  for (const [whose, run] of [
                    ["first", first],
                    ["second", second],
                  ] as const) {
                    if (run.at !== THROUGH || mode === "rotates the epoch on every response")
                      continue
                    const shown = [
                      ...(run.caught && listed.posts?.[call] === undefined
                        ? [[named, run.returned] as const]
                        : []),
                      ...run.settled
                        .filter(([part]) => SWEEP_OPEN[`${surface.name}: ${part}`] === undefined)
                        .map(([part, value]) => [`${part} after ${named}`, value] as const),
                    ]
                    for (const [what, value] of shown)
                      if (value.includes('"between"'))
                        problems.push(
                          `${what}, server ${mode}, earlier loads for the ${whose} visitor, shows what was loaded for the visitor in between once another tab's change landed: ${value}`,
                        )
                  }
                } else if (second.at !== "before the call") {
                  // A call the change caught mid-load ends as the same call made once it landed.
                  const after = await answer(
                    held.name,
                    fn,
                    list,
                    "second",
                    mode,
                    ROTATIONS,
                    "before the call",
                  )
                  const caught = `${named} caught by the change`
                  if (listed.posts?.[call] === undefined)
                    compare(name, mode, second.returned, after.returned, caught, "made after it")
                  for (const [index, [part, shown]] of second.settled.entries())
                    compare(
                      part,
                      mode,
                      shown,
                      after.settled[index]?.[1] ?? "",
                      `${part} after ${caught}`,
                      "made after it",
                    )
                }
                for (const [whose, run] of [
                  ["first", first],
                  ["second", second],
                ] as const) {
                  const [atSettle, final] = run.ends ?? ["", ""]
                  if (atSettle !== final)
                    problems.push(
                      `${named} settles before what it ends with does, server ${mode}, earlier loads for the ${whose} visitor: ${atSettle} - then ${final}`,
                    )
                }
                // The outcome a caller sees is the server's: a load it waited on that failed is reported.
                for (const [whose, run] of [
                  ["first", first],
                  ["second", second],
                ] as const)
                  if (run.swallowed && listed.quiet?.[call] === undefined) {
                    problems.push(
                      `${named} resolves though a load failed while it was pending, earlier loads for the ${whose} visitor`,
                    )
                  } else if (run.swallowed) quietedBy(surface.name).add(call)
                for (const [whose, run] of [
                  ["first", first],
                  ["second", second],
                ] as const) {
                  const [answered, shown] = run.posted ?? ["", ""]
                  if (answered !== shown)
                    problems.push(
                      `${named} shows ${shown} for a POST the server answered with ${answered}, server ${mode}, earlier loads for the ${whose} visitor`,
                    )
                }
                if (mode !== "rotates the epoch on every response") continue
                for (const [whose, run] of [
                  ["first", first],
                  ["second", second],
                ] as const) {
                  const longer = await answer(
                    held.name,
                    fn,
                    list,
                    whose,
                    mode,
                    2 * ROTATIONS,
                    run.at,
                  )
                  if (longer.loads !== run.loads)
                    problems.push(
                      `${named}, earlier loads for the ${whose} visitor: ${run.loads} loads against a server that rotates the epoch ${ROTATIONS} times, ${longer.loads} against one that rotates ${2 * ROTATIONS} times`,
                    )
                }
              }
            }
          }
        for (const call of Object.keys(listed.calls))
          if (!swept.has(call)) problems.push(`${call}: no such function`)
        for (const [call, ends] of Object.entries(listed.ends ?? {}))
          if (!swept.has(call)) problems.push(`${call}: ends for no such function`)
          else if (typeof ends === "string" && ends.includes("say in ends")) problems.push(ends)
        for (const call of Object.keys(listed.quiet ?? {}))
          if (!swept.has(call)) problems.push(`${call}: quiet for no such function`)
        for (const call of Object.keys(listed.posts ?? {}))
          if (!swept.has(call)) problems.push(`${call}: posts for no such function`)
        expect(problems).toEqual([])
      })
  test(`every call quiet about a failure on what a page holds of ${surface.name}, and every answer of it still open, still is somewhere in the sweep`, async () => {
    // A filtered run sees only some of the sweep.
    if (sweeps.get(surface.name) !== CHANGES.length * TIMINGS.length) return
    const listed = await asPage(() => surface.open({ who: "second" }))
    listed.close?.()
    expect([
      ...Object.keys(listed.quiet ?? {})
        .filter((call) => !quietedBy(surface.name).has(call))
        .map((call) => `${call}: reports every failure now; take it out of quiet`),
      ...Object.keys(SWEEP_OPEN)
        .filter((open) => open.startsWith(`${surface.name}: `) && !differed.has(open))
        .map((open) =>
          compared.has(open)
            ? `${open}: answers the same now; take it out of SWEEP_OPEN`
            : `${open}: nothing answers there`,
        ),
    ]).toEqual([])
  })
}

/** A test elsewhere that proves an identity change keeps this store's data from the next visitor. */
interface Elsewhere {
  readonly file: string
  readonly title: string
}

/** Visitor data, with its proof; any other store, with why it holds nothing a later visitor sees. */
type Entry = { readonly scenario: ScenarioId } | Elsewhere | string

const ONE_CALL = "made for one call and dropped with it; the scan sees it passed on"
const LISTENERS = "subscriber callbacks"
const MEMO = "memoized components, weakly keyed by the component they wrap"
const MATCHING = "route matching built from the app's patterns: a matched route and its params"
const SERVER_TAGS = "tags server code puts on a server's hooks and routes, weakly keyed by them"
const KEPT_VIEW =
  "the view of a kept page's slot; it goes with the slot when the keep-alive client drops the page"
const RENDER_PROPS = "render props, weakly keyed by the router state they are derived from"
const LIVE_BOOKKEEPING = "which live tags and queries the loads on screen watch; no loaded data"
const ISLAND_GRAPH = "the dependency graph of mounted islands' signals; values live in the signals"
const KEEP_ALIVE_DROPS: Elsewhere = {
  file: "packages/web/test/keep-alive.test.ts",
  title: "another tab's sign-out, identityChanged() and a visible tab's new epoch each drop",
}
const SCOPE_CLEARS: Elsewhere = {
  file: "packages/web/test/server-components-client.test.ts",
  title:
    "scope invalidation clears private controller payloads and a subsequent verified adoption can mount",
}

const STORES: Readonly<Record<string, Readonly<Record<string, Entry>>>> = {
  "packages/client/src/client.ts": {
    CUSTOM_REGISTRIES: "a codec's registry, weakly keyed by the codec",
    "children@createProxy": "the typed client's path proxies, built from route names",
  },
  "packages/client/src/ws.ts": { "listeners@openWebSocket": LISTENERS },
  "packages/core/src/classification.ts": { "seen@reflectClassification": ONE_CALL },
  "packages/core/src/evidence.ts": { "routeKeys@composeProjectEvidence": ONE_CALL },
  "packages/core/src/internal/hook-origins.ts": {
    "<expr>@routeSitesOf": SERVER_TAGS,
    "<expr>@tagRouteSite": SERVER_TAGS,
    adoptions: SERVER_TAGS,
    mergeAuthGaps: SERVER_TAGS,
    origins: SERVER_TAGS,
    routeSites: SERVER_TAGS,
    scopes: SERVER_TAGS,
    sources: SERVER_TAGS,
    statics: SERVER_TAGS,
  },
  "packages/core/src/internal/route-assurance.ts": { declarations: SERVER_TAGS },
  "packages/core/src/mount.ts": {
    RESIDENT_BODIES: "marks response bodies a server holds in memory; server code writes it",
  },
  "packages/core/src/reflection.ts": {
    "labels@reflectHooks": ONE_CALL,
    "prefixes@visit": ONE_CALL,
    "seen@declaredMountRoutes": ONE_CALL,
    "seen@reflectMergeAuthGaps": ONE_CALL,
    "seen@reflectRouteSites": ONE_CALL,
    "sites@reflectRouteSites": ONE_CALL,
  },
  "packages/core/src/router/pattern.ts": { MATCHER_CACHE: MATCHING },
  "packages/core/src/router/router.ts": {
    DYNAMIC_MATCH_CACHES: MATCHING,
    "cache@maybeCacheDynamicMatch": MATCHING,
    "handlers@add": MATCHING,
    "staticChildren@createNode": MATCHING,
    "staticMatches@add": MATCHING,
    "this.staticRoutes@Router": MATCHING,
  },
  "packages/core/src/server/base64-answers.ts": { "<expr>@encodedBody": ONE_CALL },
  "packages/core/src/transport-codec.ts": {
    "byId@createTransportCodecRegistry": "codecs the app registers",
    "byMedia@createTransportCodecRegistry": "codecs the app registers",
  },
  "packages/web-preact/src/keep-alive.ts": {
    slotsElements: "one element per slot parent, keyed by its id",
  },
  "packages/web-preact/src/memo-chain.ts": { "held@memoized": MEMO },
  "packages/web-preact/src/slot.ts": { slotted: MEMO },
  "packages/web-react/src/keep-alive.ts": {
    slotsElements: "one element per slot parent, keyed by its id",
  },
  "packages/web-react/src/memo-chain.ts": { "held@memoized": MEMO },
  "packages/web-react/src/server-components/client.ts": {
    "#listeners@FlightRoot": LISTENERS,
    "<expr>@prepareTree": ONE_CALL,
  },
  "packages/web-react/src/slot.ts": { slotted: MEMO },
  "packages/web-vanilla/src/html.ts": {
    callSites: "parsed templates, weakly keyed by the template's strings",
  },
  "packages/web-vue/src/client.ts": { levels: MEMO },
  "packages/web-vue/src/compose.ts": {
    declared: "components' declared prop names, weakly keyed by the component",
    "names@declaredBy": "a component's declared prop names",
  },
  "packages/web-vue/src/keep-alive.ts": {
    "kept@mountRouter": KEPT_VIEW,
    "slots@mountRouter": "one component per slot key, named for <KeepAlive include>",
  },
  "packages/web/src/client.ts": {
    "native@installForms": "forms that opted out of enhancement",
    stylesheetWaits: "load promises, weakly keyed by the stylesheet link",
  },
  "packages/web/src/deferred.ts": {
    "byId@markersFromPlaceholders": ONE_CALL,
    "pending@parseNdjsonData":
      "deferred values of one response; they belong to the route data that carries them",
  },
  "packages/web/src/fn-state.ts": { "listeners@createServerFnStore": LISTENERS },
  "packages/web/src/identity.ts": { "listeners@listenersOf": LISTENERS },
  "packages/web/src/internal/deferred-free.ts": {
    deferredFree: "marks values known to hold no deferred, weakly",
  },
  "packages/web/src/internal/head-merge.ts": {
    DYNAMIC_META: "marks meta objects by origin, weakly",
    STATIC_META: "marks meta objects by origin, weakly",
  },
  "packages/web/src/internal/island-bindings.ts": { warned: "binding names already warned about" },
  "packages/web/src/internal/island-list.ts": {
    "next@bindList": "a mounted island list's rows, keyed by row key; they go with the island",
    "stays@inOrder": ONE_CALL,
  },
  "packages/web/src/internal/island-signals.ts": {
    "deps@effect": ISLAND_GRAPH,
    "deps@watch": ISLAND_GRAPH,
    readers: ISLAND_GRAPH,
    "subs@computed": ISLAND_GRAPH,
    "subs@signal": ISLAND_GRAPH,
  },
  "packages/web/src/internal/keep-alive-mount.ts": {
    "nodes@slotChildren": "the slot tree of one render, by parent",
    "props@propsByState": RENDER_PROPS,
  },
  "packages/web/src/internal/live-queries.ts": {
    queries: "mounted queries and the live tick each registered at",
    watchers: LISTENERS,
  },
  "packages/web/src/internal/loading-runtime.ts": {
    "components@withLoading": "loaded `_loading` component modules",
    "handles@withLoading": "loaded `_loading` component modules",
    "inflight@withLoading": "module loads in flight",
    "listeners@withLoading": LISTENERS,
  },
  "packages/web/src/internal/output-guard.ts": {
    "<expr>@Compiler": ONE_CALL,
    "<expr>@merged": ONE_CALL,
    compiled: "output guards compiled from schemas, weakly keyed by the schema",
    "ids@Compiler": "a schema's definitions by id",
    "issueFree@Compiler": "compiled projections known to raise no issue",
    "memo@Compiler": "compiled projections by schema node",
    "properties@mergeObjects": ONE_CALL,
    warnedDrops: "field paths already warned about",
  },
  "packages/web/src/internal/page-events.ts": {
    "pending@onPageRelease": "release callbacks of a kept page",
    releases: "release callbacks, weakly keyed by the kept page",
  },
  "packages/web/src/internal/share-data.ts": {
    "<expr>@shareData": ONE_CALL,
    "byId@share": ONE_CALL,
  },
  "packages/web/src/islands-swap.ts": {
    "pending@enableSwap": "abort controllers of swaps in flight, keyed by element",
    "stops@enableSwap": "cleanups of mounted islands, keyed by node",
  },
  "packages/web/src/islands.ts": {
    "channels@createIslandBus": LISTENERS,
    "handlers@on": LISTENERS,
  },
  "packages/web/src/keep-alive.ts": {
    "<expr>@slotTree": ONE_CALL,
    "<expr>@unplaceable": ONE_CALL,
    "before@attach": LISTENERS,
    "before@slotTree": ONE_CALL,
    "entryRefs@createSlotParking": KEPT_VIEW,
    "fresh@keepAliveClient": {
      file: "packages/web/test/keep-alive.test.ts",
      title: "the page on screen through a sign-in is not kept with the previous visitor's data",
    },
    keptViews: KEPT_VIEW,
    "listeners@attach": LISTENERS,
    "pageRefs@createSlotParking": KEPT_VIEW,
    "records@attach": KEEP_ALIVE_DROPS,
    reportedCss: "stylesheets already reported",
    "slots@createSlotParking": KEPT_VIEW,
    "sources@sourcesOf": "the client-loader sources of one page record; they go with the record",
    "wrappedFetchers@attach": "wrappers around the router's fetchers; the data is the router's",
  },
  "packages/web/src/live-client.ts": {
    "changedWhileMatching@scheduleMatch": LIVE_BOOKKEEPING,
    "digesters@liveClient": "query-key digesters per load salt, while the load is on screen",
    "dirty@frameFor": LIVE_BOOKKEEPING,
    "found@matchQueries": LIVE_BOOKKEEPING,
    "frame.dirty@onReady": LIVE_BOOKKEEPING,
    "heldSince@liveClient": LIVE_BOOKKEEPING,
    "issued@liveClient": "the live loads this client put in router state, weakly keyed by them",
    "made@digestOf": "query-key digests of one load salt",
    "next@matchQueries": LIVE_BOOKKEEPING,
    "pollFailures@liveClient": "poll failure counts per frame",
    "queries@matchQueries": LIVE_BOOKKEEPING,
    "tags@adoptSeed": LIVE_BOOKKEEPING,
    "tags@fetchData": LIVE_BOOKKEEPING,
    "tags@queryKeysOf": LIVE_BOOKKEEPING,
    "tried@liveClient": "frames already given a grant load under this socket",
    "warned@liveClient": "codes already warned about",
  },
  "packages/web/src/query.ts": {
    "cache@createQueryClient": { scenario: "query" },
    "infinite@createQueryClient": { scenario: "query-infinite" },
    "listeners@createMutation": LISTENERS,
    "listeners@makeEntry": LISTENERS,
    "listeners@makeInfinite": LISTENERS,
    "seeded@createQueryClient": { scenario: "query-seed" },
  },
  "packages/web/src/router.ts": {
    PRERENDERED_SET_CACHE: "prerendered paths, weakly keyed by the build's list",
    "cache@createClientRouter": { scenario: "router-revisit" },
    "fListeners@createFetcher": LISTENERS,
    "fetcherListeners@createClientRouter": LISTENERS,
    "fetchers@createClientRouter": { scenario: "router-fetcher" },
    "inflight@createClientRouter": { scenario: "router-prefetch" },
    "interceptMatchers@createClientRouter": MATCHING,
    "listeners@createClientRouter": LISTENERS,
    "prefetched@createClientRouter": { scenario: "router-prefetch" },
  },
  "packages/web/src/server-components/client.ts": {
    "#mountWaiters@ComponentController": LISTENERS,
    "#mounted@ComponentController": SCOPE_CLEARS,
    "#parked@ComponentController": {
      file: "packages/web/test/server-components-client.test.ts",
      title: "a scope change releases parked components with the rest",
    },
    "#restorable@ComponentController": SCOPE_CLEARS,
    "#teardown@ComponentController": "teardowns in flight, weakly keyed by host element",
    "ids@recordSubtree": ONE_CALL,
    reloadedBuilds: "build ids already reloaded for",
    "waiters@whenReady": LISTENERS,
  },
  "packages/web/src/server-components/portal.ts": {
    cleanups: "portal cleanups, weakly keyed by the owner element",
    "entries@ownComponentPortal": "portal cleanups of one owner element",
  },
  "packages/web/src/server-components/props.ts": {
    guards: "output guards, weakly keyed by the schema",
  },
  "packages/web/src/server-components/range.ts": {
    "#mounted@NativeRange": "islands mounted inside one server component; they go when it unmounts",
    "contracts@nativeComponentClient": "the app's client island contracts",
    "map@hosts": ONE_CALL,
    "nested@prepare": ONE_CALL,
    "next@NativeRange": ONE_CALL,
  },
  "packages/web/src/server-components/registry.ts": {
    componentControllers: "the page's component controllers, for dev reload",
  },
  "packages/web/src/server-components/schema.ts": {
    "checked@assertComponentSchema": ONE_CALL,
    "visiting@assertComponentSchema": ONE_CALL,
  },
  "packages/web/src/server-components/state.ts": {
    "ids@parseComponentState": ONE_CALL,
    "islandIds@parseComponentState": ONE_CALL,
  },
  "packages/web/src/server-components/value.ts": { "seen@componentValue": ONE_CALL },
}

// The scan passes an entry it cannot read as source, so a misspelled or renamed one would pass too,
// with every module only it imports unscanned.
test("every entry the scan starts from is one its package exports", () => {
  const missing = ENTRIES.flatMap(([pkg, subpaths]) =>
    subpaths.filter((subpath) => exportOf(pkg, subpath) === undefined).map((s) => `${pkg} ${s}`),
  )
  expect(missing).toEqual([])
})

test("every store a page keeps past one call is enrolled, as visitor data with its proof or as not", () => {
  const unknown: string[] = []
  const stale: string[] = []
  const found = scan()
  for (const [file, stores] of found)
    for (const store of new Set(stores))
      if (STORES[file]?.[store] === undefined) unknown.push(`${file} ${store}`)
  for (const [file, entries] of Object.entries(STORES))
    for (const store of Object.keys(entries))
      if (found.get(file)?.includes(store) !== true) stale.push(`${file} ${store}`)
  expect({ unknown, stale }).toEqual({ unknown: [], stale: [] })
})

/** Modules holding visitor data that no surface sweeps yet, each with what proves it instead. */
const UNSWEPT: Readonly<Record<string, string>> = {
  "packages/web/src/keep-alive.ts":
    "needs a DOM and the History API to keep pages; the tests KEEP_ALIVE_DROPS names drop its pages by hand",
  "packages/web/src/server-components/client.ts":
    "needs a component manifest and a DOM to mount into; the test SCOPE_CLEARS names clears it by hand",
}

test("every module holding visitor data is swept, or says why not", () => {
  const holding = Object.entries(STORES)
    .filter(([, entries]) => Object.values(entries).some((entry) => typeof entry === "object"))
    .map(([file]) => file)
  const swept = new Set(SURFACES.flatMap((surface) => surface.files))
  expect({
    unswept: holding.filter((file) => !swept.has(file) && UNSWEPT[file] === undefined),
    stale: Object.keys(UNSWEPT).filter((file) => swept.has(file) || !holding.includes(file)),
  }).toEqual({ unswept: [], stale: [] })
})

test("every proof a store names exists", () => {
  const proofs = Object.values(STORES).flatMap((entries) => Object.values(entries))
  const missing = proofs.flatMap((entry) =>
    typeof entry === "object" &&
    "file" in entry &&
    !readFileSync(join(ROOT, entry.file), "utf8").includes(`"${entry.title}"`)
      ? [`${entry.file}: ${entry.title}`]
      : [],
  )
  const named = new Set(
    proofs.flatMap((entry) =>
      typeof entry === "object" && "scenario" in entry ? [entry.scenario] : [],
    ),
  )
  const unused = SCENARIOS.flatMap(({ id }) => (named.has(id) ? [] : [id]))
  expect({ missing, unused }).toEqual({ missing: [], unused: [] })
})

test("the scan finds a store that outlives its call, and passes one that cannot", () => {
  const { stores } = moduleOf(
    "fixture.ts",
    `
const TABLE = new Set(["a", "b"])
const pages = new Map()
export function remember(path, data) { pages.set(path, data) }
export function router() {
  const warmed = new Map()
  const scratch = new Set()
  for (const x of [1, 2]) scratch.add(x)
  const unique = [...new Set([1, 1])]
  const state = { held: new WeakMap() }
  return {
    warm: (path, data) => warmed.set(path, data),
    keep: (key, value) => state.held.set(key, value),
    size: scratch.size + unique.length,
  }
}
export class Cache { entries = new Map(); put(k, v) { this.entries.set(k, v) } }
`,
  )
  expect(stores).toEqual(["pages", "warmed@router", "held@router", "entries@Cache"])
})
