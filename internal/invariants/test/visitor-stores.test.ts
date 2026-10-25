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
          "island",
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
function sourceOf(pkg: string, subpath: string): string | undefined {
  const dir = join(ROOT, "packages", pkg)
  const manifest: { exports?: Record<string, unknown> } = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  )
  const target = manifest.exports?.[subpath === "." ? "." : `./${subpath}`]
  const path =
    typeof target === "string"
      ? target
      : typeof target === "object" && target !== null
        ? Reflect.get(target, "bun")
        : undefined
  return typeof path === "string" && /\.tsx?$/.test(path) ? join(dir, path) : undefined
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
  /** The visitor the app's loaders and fetches answer for. */
  who: "first" | "second"
}

type Change = (visit: Visit) => Promise<void>

const pages = [
  { routeId: "index", pattern: "/" },
  { routeId: "me", pattern: "/me" },
]
const start = { routeId: "index", params: {}, path: "/", data: null, pending: false }
const routerFor = (visit: Visit) =>
  createClientRouter({
    patterns: pages,
    initial: start,
    fetchData: async () => ({ who: visit.who }),
  })
const feed = { initialPageParam: 0, getNextPageParam: () => undefined }

/** Each scenario loads as the first visitor, changes visitor, and returns what the second sees. */
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
      await router.fetcher("account").load("/me")
      await change(visit)
      return router.fetcher("account").snapshot().data
    },
  },
  {
    id: "query",
    title: "a query cached for the first visitor is not what the second reads",
    run: async (change: Change) => {
      const visit: Visit = { who: "first" }
      const queries = createQueryClient({ now: () => 0 })
      const load = async () => ({ who: visit.who })
      await queries.query(["me"], load).fetch()
      await change(visit)
      return queries.query(["me"], load).snapshot().data
    },
  },
  {
    id: "query-infinite",
    title: "an infinite query's pages for the first visitor are not what the second reads",
    run: async (change: Change) => {
      const visit: Visit = { who: "first" }
      const queries = createQueryClient({ now: () => 0 })
      const load = async () => ({ who: visit.who })
      await queries.infiniteQuery(["feed"], load, feed).fetch()
      await change(visit)
      return queries.infiniteQuery(["feed"], load, feed).snapshot().data
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
  (run: (change: Change) => Promise<unknown>) => Promise<unknown>,
])[] = [
  [
    "identityChanged()",
    (run) =>
      run(async (visit) => {
        visit.who = "second"
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
          visit.who = "second"
          document.cookie = "nifra-epoch=second"
        })
      } finally {
        if (held === undefined) Reflect.deleteProperty(globalThis, "document")
        else Object.defineProperty(globalThis, "document", held)
      }
    },
  ],
]

for (const scenario of SCENARIOS)
  for (const [change, through] of CHANGES) {
    const open = OPEN[scenario.id]
    const title = `${scenario.title}, after ${change}${open === undefined ? "" : ` - open: ${open}`}`
    const check = async () => {
      // A page: query clients a server builds per request are never adopted.
      const held = Object.getOwnPropertyDescriptor(globalThis, "window")
      Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true })
      try {
        const seen = await through(scenario.run)
        expect(JSON.stringify(seen) ?? "").not.toContain("first")
      } finally {
        if (held === undefined) Reflect.deleteProperty(globalThis, "window")
        else Object.defineProperty(globalThis, "window", held)
      }
    }
    if (open === undefined) test(title, check)
    else test.failing(title, check)
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
  "packages/web-preact/src/client.ts": { "held@memoized": MEMO },
  "packages/web-preact/src/keep-alive.ts": {
    "held@memoized": MEMO,
    "nodes@childrenOf": "the slot tree of one render, read through context",
    "props@mountRouter": RENDER_PROPS,
    slotsElements: "one element per slot parent, keyed by its id",
  },
  "packages/web-preact/src/slot.ts": { slotted: MEMO },
  "packages/web-react/src/client.ts": { "held@memoized": MEMO },
  "packages/web-react/src/keep-alive.ts": {
    "held@memoized": MEMO,
    "nodes@childrenOf": "the slot tree of one render, read through context",
    "props@mountRouter": RENDER_PROPS,
    slotsElements: "one element per slot parent, keyed by its id",
  },
  "packages/web-react/src/server-components/client.ts": {
    "#listeners@FlightRoot": LISTENERS,
    "<expr>@prepareTree": ONE_CALL,
  },
  "packages/web-react/src/slot.ts": { slotted: MEMO },
  "packages/web-svelte/src/keep-alive.ts": { "props@mountRouter": RENDER_PROPS },
  "packages/web-vanilla/src/html.ts": {
    callSites: "parsed templates, weakly keyed by the template's strings",
  },
  "packages/web-vue/src/client.ts": { levels: MEMO },
  "packages/web-vue/src/compose.ts": {
    "<expr>@declaredProps": "a component's declared prop names",
  },
  "packages/web-vue/src/keep-alive.ts": {
    "children@mountRouter": "the slot tree of the router's latest state",
    "kept@mountRouter": KEPT_VIEW,
    "props@mountRouter": RENDER_PROPS,
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
