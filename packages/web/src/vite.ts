/**
 * `@nifrajs/web/vite` - a **dev-only** server with true HMR, backed by Vite in middleware mode. nifra's
 * production pipeline stays Bun-native (`@nifrajs/web/build` → `Bun.build`); this is purely for the dev
 * loop. Bun's own HMR is dev-server-only and DCE's `import.meta.hot` under `Bun.build` (nifra's bundler),
 * so HMR comes from Vite + the framework's official Vite plugin (React Fast Refresh, Vue/Svelte/Solid
 * HMR) - which you inject via `plugins` (the same structural-injection idiom as the Bun/codec plugins).
 *
 * Flow: Vite serves + HMR-swaps the client modules (nifra's codegen'd entry + the route files); nifra
 * still **SSRs** each request, and the rendered HTML is run through `vite.transformIndexHtml` so Vite
 * injects its HMR client + the framework's refresh preamble. Node `http` (not `Bun.serve`) because
 * Vite's `middlewares` are Connect-style - it runs fine under Bun.
 */
import { writeFileSync } from "node:fs"
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { relative, resolve as resolvePath } from "node:path"
import { createDevDiagnostics } from "./dev-diagnostics.ts"
import { listenOrExplain } from "./dev-port.ts"
import { discoverRoutes } from "./fs.ts"
import { DEFAULT_DEV_PORT, generateClientEntry, setSsrModuleLoader } from "./index.ts"
import { viteDedupePackages } from "./internal/identity-policy.ts"
import {
  assertIdentityParity,
  collectIdentityParity,
  formatIdentityParityFindings,
  identityParityHeadline,
} from "./internal/parity.ts"
import { vitePublicEnvPrefix } from "./internal/server-boundary.ts"
import { importVite } from "./internal/vite-import.ts"
import { scopedName } from "./plugins/css-modules.ts"
import { DEV_ROOT_ENV, DEV_ROUTES_ENV, reproduciblePath } from "./plugins/kit.ts"
import { viteServerFnStub } from "./plugins/vite-server-fn.ts"
import { viteServerOnlyEmpty } from "./plugins/vite-server-only.ts"

/** Minimal app surface - `createWebApp(...)` satisfies it. */
interface FetchApp {
  fetch(request: Request): Response | Promise<Response>
}

// A node in Vite's module graph. `importers` is the union of client and SSR importers - walking it
// over-invalidates (a client-only importer gets re-evaluated on the SSR side too), which is safe:
// re-evaluation is idempotent, and correctness of the served module beats sparing a dev re-eval.
interface ViteModuleNode {
  readonly importers: Set<ViteModuleNode>
}
// Structural slice of Vite's legacy unified module graph. Absent on a Vite that renamed it (the
// invalidation degrades to Vite's own change handling, i.e. today's behavior) - never a hard failure.
interface ViteModuleGraph {
  getModulesByFile(file: string): Set<ViteModuleNode> | undefined
  invalidateModule(mod: ViteModuleNode): void
}
// Structural slice of the Vite dev server this module drives (avoids a hard type dep on `vite`).
interface ViteLike {
  /** Load a module through VITE's graph - the seam that makes the Vite pipeline own SSR too. */
  ssrLoadModule(url: string): Promise<Record<string, unknown>>
  readonly middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void
  transformIndexHtml(url: string, html: string): Promise<string>
  ssrFixStacktrace(err: Error): void
  /** The module graph, used to invalidate a changed file AND its transitive importers before reload. */
  readonly moduleGraph?: ViteModuleGraph
  readonly watcher: {
    on(event: "change" | "add" | "unlink", cb: (path: string) => void): void
  }
  close(): Promise<void>
}
interface ViteModule {
  createServer(config: Record<string, unknown>): Promise<ViteLike>
  // Present only on rolldown-vite (Vite 8+); used to gate the optimizeDeps.jsx-key normalization below.
  readonly rolldownVersion?: string
}

// `node:http` server type the request handler runs on (also the HMR WebSocket host - see below).
type NodeHttpServer = ReturnType<typeof createHttpServer>

export interface ViteDevServerOptions {
  /** Absolute (or cwd-relative) path to the `routes/` dir. */
  readonly routesDir: string
  /** Client runtime module providing `mountRouter` (e.g. `"@nifrajs/web-react/client"`). */
  readonly clientModule: string
  /**
   * Build the nifra app for the given dev client-entry URL.
   *
   * `load` resolves a route module through **Vite's** graph (`ssrLoadModule`). Pass it to
   * `discoverRoutes(routesDir, { load })` so SSR and the client are resolved by the SAME toolchain.
   * Without it SSR resolves through Bun while the client resolves through Vite - two resolvers, one
   * process - which is what makes `resolve.dedupe` fail to reach SSR and produces the dual-React
   * crash. Vite re-evaluates on change, so no `importQuery` cache-buster is needed alongside it.
   */
  readonly createApp: (
    clientEntry: string,
    load: (absolutePath: string) => Promise<unknown>,
  ) => FetchApp | Promise<FetchApp>
  /** Vite plugins - inject your framework's official plugin, e.g. `[react()]`. */
  readonly plugins?: readonly unknown[]
  /**
   * Extra `resolve.conditions` prepended ahead of nifra's defaults - some frameworks need their own
   * (e.g. Solid's `"solid"` condition routes `solid-js` to its source/JSX-dev build).
   */
  readonly conditions?: readonly string[]
  /**
   * Compile-time `define` replacements (e.g. Vue's `__VUE_OPTIONS_API__` flags). Vite already sets
   * `process.env.NODE_ENV` in dev; this is for framework feature flags the plugin doesn't inject.
   */
  readonly define?: Readonly<Record<string, string>>
  /** Vite project root (default `process.cwd()`). */
  readonly root?: string
  /** Port (default {@link DEFAULT_DEV_PORT}). */
  readonly port?: number
  /**
   * Use polling for the file watcher. Native fs events (fsevents/inotify) are unreliable inside
   * containers, networked filesystems, and some sandboxes - there, HMR silently never fires. Set
   * `true` (or the env var `CHOKIDAR_USEPOLLING=1`) to poll instead. Default: off (native events).
   */
  readonly poll?: boolean
  /** Vite public directory. Defaults to `<root>/public`; `false` disables it. */
  readonly publicDir?: string | false
  /** Client-visible environment prefix (default `"PUBLIC_"`; empty disables exposure). */
  readonly publicEnvPrefix?: string
  /**
   * Downgrade the startup identity-parity check from a hard failure to a loud warning (dev only).
   * The check catches two physical copies of an identity-sensitive package (e.g. React) resolving in
   * one process, which reliably breaks hydration and framework context. When a duplicate comes from a
   * linked sibling repo you cannot fix in the moment, set this to keep the dev server running while you
   * resolve it; `nifra build` never honors it. Wired to `nifra dev --allow-duplicate-identity`.
   */
  readonly allowDuplicateIdentity?: boolean
}

export interface ViteDevServer {
  readonly port: number
  stop(): Promise<void>
}

export { LAST_ERROR_PATH } from "./diagnostic.ts"

// The codegen'd client entry is written here (at the Vite root) so Vite serves + HMRs it.
const DEV_ENTRY = ".nifra-vite-entry.tsx"

const readNodeBody = async (req: IncomingMessage): Promise<Buffer | undefined> => {
  if (req.method === "GET" || req.method === "HEAD") return undefined
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Build a Web `Request` from a Node `IncomingMessage` (+ already-read body) for nifra's `app.fetch`. */
function toWebRequest(req: IncomingMessage, body: Buffer | undefined): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value)
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v)
  }
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`
  // Assemble init via an `unknown`-typed `body` slot: a Buffer is a valid request body at runtime
  // (Bun/undici), but the named `BodyInit` type only exists under the DOM lib (the root program is
  // DOM-free). `ConstructorParameters<typeof Request>[1]` derives the init type from whichever lib is
  // active, so this type-checks in both the bun and DOM tsconfig programs.
  const init: { method: string; headers: Headers; body?: unknown } = {
    method: req.method ?? "GET",
    headers,
  }
  if (body !== undefined) init.body = body
  return new Request(url, init as unknown as ConstructorParameters<typeof Request>[1])
}

// A Vite `config` hook: a plain function, OR the object form `{ handler, order }` Vite accepts for hook
// ordering (`order: "pre" | "post"`). We wrap the handler in either shape - see normalizeRolldownPlugins.
type ConfigFn = (config: unknown, env: unknown) => unknown
type ConfigHook = ConfigFn | { readonly handler: ConfigFn; readonly order?: unknown }

// A Vite plugin - the only hook we wrap is `config`. Typed structurally (no `vite` type dep). Everything
// else on the plugin object is preserved by spread, so wrapping is transparent to Vite.
interface VitePluginLike {
  readonly name?: string
  config?: ConfigHook
  readonly [key: string]: unknown
}

/** The bits of a Node ServerResponse `pipeWebBodyToNode` touches - structural, to avoid a node:http dep here. */
interface NodeResLike {
  flushHeaders?(): void
  on(event: "close", cb: () => void): void
  write(chunk: Uint8Array): boolean
  end(): void
}

/** Structural slice of a Node response for header writing. */
interface NodeHeaderSink {
  setHeader(name: string, value: string | readonly string[]): void
}

/**
 * Copy a Web `Response`'s headers onto a Node response, emitting EACH `Set-Cookie` as its own header. The
 * `Headers` iterator (and `.get`) join multiple set-cookie values with ", ", which corrupts cookies - e.g.
 * better-auth's `session_token` + `session_data` collapse into one unparseable cookie and the session is
 * silently lost. `getSetCookie()` returns them split; Node's `setHeader` emits one header per array element.
 */
export function applyResponseHeaders(headers: Headers, res: NodeHeaderSink): void {
  for (const [key, value] of headers) {
    if (key.toLowerCase() === "set-cookie") continue
    res.setHeader(key, value)
  }
  const cookies = headers.getSetCookie?.()
  if (cookies && cookies.length > 0) res.setHeader("set-cookie", cookies)
}

/**
 * Stream a Web `Response` body to a Node response chunk-by-chunk. Buffering the whole body (e.g.
 * `arrayBuffer()`) waits for the stream to END - which an open-ended SSE (`text/event-stream`) body never
 * does, so it hung `nifra dev` (the Bun production server streamed it fine). This flushes each chunk as it
 * arrives and cancels the reader if the client disconnects; a finite body just streams its chunk(s) + ends.
 */
export async function pipeWebBodyToNode(
  body: ReadableStream<Uint8Array> | null,
  res: NodeResLike,
): Promise<void> {
  if (!body) {
    res.end()
    return
  }
  const reader = body.getReader()
  res.flushHeaders?.()
  res.on("close", () => void reader.cancel().catch(() => {}))
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  } catch {
    // client disconnected mid-stream - the `close` handler already cancelled the reader
  }
  res.end()
}

/**
 * Strip `optimizeDeps.rollupOptions.jsx` from a plugin's `config` hook output when running under
 * rolldown-vite - the source of the scary, harmless `Warning: Invalid input options … "jsx" Invalid
 * key: Expected never but received "jsx"` on `nifra dev`.
 *
 * Why it happens: `@vitejs/plugin-react@4.x` (and peers) target an *older* rolldown-vite optimizeDeps
 * API - they inject `optimizeDeps.rollupOptions.jsx` to tell the dep pre-bundler to transform JSX. Vite
 * 8's rolldown dep-optimizer renamed that surface to `optimizeDeps.rolldownOptions` (and moved jsx under
 * `transform.jsx`), so the stale `rollupOptions.jsx` is an unrecognized input option → the warning. It's
 * a version-skew artifact, not a real misconfig: the route source JSX transform runs through the
 * plugin's own `transform` hook (untouched here), and node_modules deps that get pre-bundled almost
 * never contain raw JSX - so dropping the dead key changes no behavior and keeps HMR/Fast Refresh
 * intact. We *strip* (rather than translate to `rolldownOptions`) so the fix is version-agnostic: a
 * plugin already emitting the correct `rolldownOptions` is left untouched, and a future plugin bump that
 * stops emitting `rollupOptions.jsx` makes this a no-op.
 *
 * Scoped narrowly: only the `optimizeDeps.rollupOptions.jsx` key is removed, only under rolldown-vite,
 * and only from the value a plugin's `config` hook returns. Non-rolldown Vite is passed through verbatim.
 *
 * FLATTEN FIRST: a Vite plugin factory may return an ARRAY of plugins - `@vitejs/plugin-react`'s `react()`
 * returns `[vite:react-babel, vite:react-refresh]`, and it's `react:react-babel`'s `config` hook that emits
 * the offending `optimizeDeps.rollupOptions.jsx`. `nifra.config.ts` writes `vitePlugins = [react()]`, so the
 * plugin list arrives NESTED (`[[babel, refresh]]`). Without flattening, `.map` sees the inner array (which
 * has no `config`), leaves it untouched, and Vite - which flattens plugin arrays itself before running them
 * - then executes the un-stripped babel hook, so the warning survives. Flattening here (Vite accepts a flat
 * list identically) is what lets the strip reach every real plugin.
 */
export function normalizeRolldownPlugins(
  plugins: readonly unknown[],
  isRolldown: boolean,
): readonly unknown[] {
  if (!isRolldown) return plugins
  const stripJsxKey = (returned: unknown): unknown => {
    // Only touch a plain-object config carrying optimizeDeps.rollupOptions.jsx; leave anything else as-is.
    if (returned === null || typeof returned !== "object") return returned
    const cfg = returned as { optimizeDeps?: { rollupOptions?: Record<string, unknown> } }
    const rollupOptions = cfg.optimizeDeps?.rollupOptions
    if (rollupOptions === undefined || !("jsx" in rollupOptions)) return returned
    // Clone the affected branch (never mutate the plugin's own return value) and drop the dead key.
    const { jsx: _dropped, ...restRollup } = rollupOptions
    return {
      ...cfg,
      optimizeDeps: { ...cfg.optimizeDeps, rollupOptions: restRollup },
    }
  }
  return plugins.flat(Number.POSITIVE_INFINITY).map((plugin) => {
    if (plugin === null || typeof plugin !== "object") return plugin
    const p = plugin as VitePluginLike
    // `config` may be a plain function or the object form `{ handler, order }`. Wrap the handler either way.
    const hook = p.config
    const handler = typeof hook === "function" ? hook : hook?.handler
    if (typeof handler !== "function") return plugin
    const wrappedHandler: ConfigFn = (config, env) => {
      const returned = handler(config, env)
      // The hook may return a promise - normalize both shapes.
      return returned instanceof Promise ? returned.then(stripJsxKey) : stripJsxKey(returned)
    }
    // Preserve the ORIGINAL shape: a function stays a function; the object form keeps its `order`
    // (collapsing `{ handler, order }` to a bare function would silently drop the hook ordering).
    return {
      ...p,
      config: typeof hook === "function" ? wrappedHandler : { ...hook, handler: wrappedHandler },
    }
  })
}

/**
 * The npm package a bare module specifier belongs to (`@nifrajs/web-react/client` →
 * `@nifrajs/web-react`, `some-adapter/client` → `some-adapter`), or `undefined` for a path-shaped
 * specifier (relative/absolute), which names no package.
 */
function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(specifier))
    return undefined
  const parts = specifier.split("/")
  return specifier.startsWith("@")
    ? parts.length >= 2
      ? `${parts[0]}/${parts[1]}`
      : undefined
    : parts[0]
}

/**
 * Start the Vite-backed dev server: Vite serves/HMRs the client; nifra SSRs each request and Vite
 * injects its HMR client + the framework refresh preamble via `transformIndexHtml`.
 */
export async function createViteDevServer(options: ViteDevServerOptions): Promise<ViteDevServer> {
  const root = resolvePath(options.root ?? process.cwd())
  const routesDir = resolvePath(options.routesDir)
  if (options.allowDuplicateIdentity === true) {
    const parity = await collectIdentityParity(root)
    if (parity.findings.length > 0)
      console.warn(
        `[nifra] identity parity bypassed via --allow-duplicate-identity (${identityParityHeadline(parity.findings.length)}):\n${formatIdentityParityFindings(parity.findings)}\n` +
          "[nifra] dev is continuing, but duplicate module identity can break hydration and framework context - fix the resolution before you ship.",
      )
  } else {
    await assertIdentityParity(root)
  }
  const port = options.port ?? DEFAULT_DEV_PORT

  // Which files are the app's own components, for framework plugins that hot-patch at component
  // granularity (`devHotComponent`). Announced in the environment rather than passed, because the
  // plugin that reads it is constructed by the app, in its own config, before this server exists.
  process.env[DEV_ROOT_ENV] = root
  process.env[DEV_ROUTES_ENV] = routesDir

  // Codegen the client entry with Vite-servable, root-relative specifiers (e.g. `/routes/index.tsx`).
  const toUrl = (file: string): string => `/${relative(root, `${routesDir}/${file}`)}`
  const writeClientEntry = (): void => {
    const manifest = discoverRoutes(routesDir)
    writeFileSync(
      resolvePath(root, DEV_ENTRY),
      generateClientEntry(manifest, { clientModule: options.clientModule, resolve: toUrl }),
    )
  }
  writeClientEntry()
  const entryUrl = `/${DEV_ENTRY}`

  // Create our HTTP server FIRST, then hand it to Vite as the HMR WebSocket host (`hmr.server`). In
  // middleware mode Vite would otherwise open a *separate* ws port (24678) - fragile: it conflicts
  // across restarts ("Port undefined is already in use" → the client never connects). Sharing one
  // port means HMR rides the same origin as the app, robust across restarts. The handler closes over
  // `vite`, which is assigned just below before the server starts listening.
  let vite!: ViteLike
  let app: FetchApp
  // The most recent SSR failure, served as JSON at LAST_ERROR_PATH. Shared with the Bun adapter so the
  // endpoint and its headers can't drift between the two dev servers.
  const devDiagnostics = createDevDiagnostics(root)

  const server: NodeHttpServer = createHttpServer((req, res) => {
    // Keep this before Vite's middleware: it is an agent endpoint owned by nifra, not a file or app route.
    if (devDiagnostics.isLastErrorPath((req.url ?? "/").split("?", 1)[0] ?? "/")) {
      const { body, headers } = devDiagnostics.lastError()
      res.statusCode = 200
      for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
      res.end(body)
      return
    }
    vite.middlewares(req, res, () => {
      // Not a Vite asset → nifra SSR. (`next` runs after Vite declines, so the body is still readable.)
      void (async () => {
        try {
          const body = await readNodeBody(req)
          const nifraRes = await app.fetch(toWebRequest(req, body))
          const contentType = nifraRes.headers.get("content-type") ?? ""
          res.statusCode = nifraRes.status
          if (!contentType.includes("text/html")) {
            // Data / redirect / asset response - pass through untouched, streamed (SSE-safe). Set-Cookie is
            // emitted per-header so multi-cookie responses (e.g. better-auth sessions) aren't collapsed.
            applyResponseHeaders(nifraRes.headers, res)
            await pipeWebBodyToNode(nifraRes.body, res)
            return
          }
          // Inject Vite's HMR client + the framework's refresh preamble into the SSR'd HTML.
          const html = await vite.transformIndexHtml(req.url ?? "/", await nifraRes.text())
          res.setHeader("content-type", "text/html; charset=utf-8")
          res.end(html)
        } catch (err) {
          // Source-map the stack first (Vite maps the bundled frames back to your `.ts`), then render
          // the readable dev overlay instead of a bare text dump. Dev-only - production maps to `_error`.
          if (err instanceof Error) vite.ssrFixStacktrace(err)
          const html = devDiagnostics.capture(err, {
            method: req.method ?? "GET",
            url: req.url ?? "/",
          })
          res.statusCode = 500
          res.setHeader("content-type", "text/html; charset=utf-8")
          res.end(html)
        }
      })()
    })
  })

  // `conditions: ["bun"]` makes Vite resolve nifra's workspace packages (`@nifrajs/web-react/client`, …) to
  // their TS **source** - so the dev server needs no prior `dist` build of the adapter packages.
  //
  // That covers the CLIENT half only: Vite resolves SSR through `ssr.resolve.*`, which ignores
  // `resolve.conditions`. Left at its defaults, SSR resolves a package's `default` export (`dist/…`)
  // while the app's own imports of the same package run under Bun and resolve the `bun` export
  // (`src/…`). Two consequences, both real bugs:
  //   1. The adapter package loads TWICE - the app's Bun import (the adapter passed to `createWebApp`)
  //      and the route modules' Vite-SSR import - so `createContext` runs twice and the routing hooks
  //      (`useSearch`/`useParams`/`useLocation`) read a context the render never provided: they
  //      SSR-render their EMPTY defaults in dev while the loader (same request!) sees the real values.
  //   2. SSR reads `dist`, which nothing in the dev loop rebuilds - a stale `dist` then 500s inside
  //      framework code and reads exactly like a framework regression.
  // Fix, below: `ssr.resolve.{conditions,externalConditions}` mirror the client conditions (so SSR
  // resolves the same files Bun does), and the adapter package + `@nifrajs/web` are `ssr.external`
  // (so Bun's OWN module cache serves them to route modules - one instance, one `RouterContext`).
  const resolveConditions = [
    ...(options.conditions ?? []),
    "bun",
    "module",
    "browser",
    "development",
  ]
  // SSR must not pick `browser` builds; otherwise identical to the client list so both halves agree.
  const ssrConditions = [...(options.conditions ?? []), "bun", "module", "node", "development"]
  // The adapter package (from `clientModule`, e.g. `@nifrajs/web-react/client` → `@nifrajs/web-react`)
  // - identity-sensitive (its `RouterContext` must be the ONE the Bun-imported adapter provides). A
  // path-shaped `clientModule` (tests) names no package; there is then nothing to externalize.
  const adapterPackage = packageNameOf(options.clientModule)
  const ssrExternal = [...(adapterPackage !== undefined ? [adapterPackage] : []), "@nifrajs/web"]
  const usePolling = options.poll ?? process.env.CHOKIDAR_USEPOLLING === "1"
  // Never `import("vite")` directly here: the guard in `importVite` has to run first, and the dev
  // server importing vite unguarded is precisely what poisoned the module for the whole process.
  const viteModule = await importVite<ViteModule>()
  const { createServer } = viteModule
  // Under rolldown-vite (Vite 8+), strip the stale `optimizeDeps.rollupOptions.jsx` some framework
  // plugins still emit - it triggers a noisy "Invalid key … jsx" warning but does nothing useful here.
  const plugins = normalizeRolldownPlugins(
    options.plugins ?? [],
    viteModule.rolldownVersion !== undefined,
  )
  vite = await createServer({
    root,
    // Dev must not inherit Vite's default `VITE_*` exposure beside Nifra's documented boundary.
    envPrefix: vitePublicEnvPrefix(options.publicEnvPrefix),
    ...(options.publicDir !== undefined ? { publicDir: options.publicDir } : {}),
    appType: "custom",
    server: {
      middlewareMode: true,
      hmr: { server },
      // Explicit watch config; poll when native fs events aren't delivered (containers/sandboxes).
      watch: usePolling ? { usePolling: true, interval: 80 } : {},
    },
    // Ahead of the user's plugins: a `*.fn` module must be replaced before anything else
    // reads it, and the dev server is a client bundler like any other.
    plugins: [viteServerFnStub(), viteServerOnlyEmpty(), ...plugins],
    resolve: {
      conditions: resolveConditions,
      // Dedupe each framework runtime to ONE copy. In a multi-root workspace a shared package can pull
      // react/react-dom (or preact, or svelte) from a SIBLING app's node_modules, so the dev server
      // loads two cores → a second hook dispatcher/options global → `resolveDispatcher().useState` null
      // on any hook-using route (the error points at the component, not the resolution - brutal to
      // diagnose). Same policy table the production builds read, so dev matches prod. No-op per
      // framework the app does not use (the package simply isn't present to dedupe).
      dedupe: [...viteDedupePackages()],
    },
    ssr: {
      // Explicit listing forces external even for workspace-LINKED packages (Vite's default keeps
      // linked deps internal), so a monorepo dev run gets the same single-instance guarantee as an
      // npm-installed one.
      external: ssrExternal,
      resolve: {
        // Non-externalized deps (a workspace-linked package, say): Vite's runner evaluates them, but
        // from the same files Bun would pick - `bun`-conditioned source, never a stale `dist`.
        conditions: ssrConditions,
        // Externalized deps: Vite resolves the specifier, Bun imports the result. `bun` first so the
        // resolved file IS the one already in Bun's module cache (one evaluation, shared context).
        externalConditions: ssrConditions,
      },
    },
    css: {
      modules: {
        // Vite ships its own CSS-Modules naming (`_name_<base64>`); the Bun pipeline and every
        // `nifra build` use `scopedName`. Left alone, one class is called two different things
        // depending on which pipeline served it, so a selector written against a generated name works
        // in dev and vanishes in production - and the two dev pipelines disagree with each other. The
        // name is defined once, in the plugin, and Vite is handed that definition.
        generateScopedName: (name: string, filename: string): string =>
          scopedName(reproduciblePath(filename), name),
      },
    },
    ...(options.define ? { define: options.define } : {}),
  })

  const ssrLoad = (absolutePath: string): Promise<unknown> => vite.ssrLoadModule(absolutePath)
  // Published so an ADAPTER can reach this graph too. Route modules already load through it; an
  // adapter that has to load a compiled asset of its own on the server (`@nifrajs/web-svelte` and its
  // `Chain.svelte`) would otherwise take it from the runtime, which has no compiler for it and no
  // reason to agree with Vite about which copy of the framework runtime it renders through.
  setSsrModuleLoader(ssrLoad)
  app = await options.createApp(entryUrl, ssrLoad)

  // Evict a changed file from the SSR graph together with every module that (transitively) imports it,
  // BEFORE re-creating the app. Vite re-evaluates a directly-changed module on its own, but a parent
  // that merely imports the changed leaf keeps its cached SSR bindings - so the re-imported entry walks
  // a graph that is fresh at the leaf and stale everywhere above it. That is what surfaces downstream as
  // phantom hydration mismatches (SSR renders through an old module, the client through the new one) and
  // stale i18n catalogs. Invalidating the importer closure makes the next `ssrLoadModule(entry)` re-walk
  // the whole affected subtree. `importers` is the client+SSR union, so this over-invalidates slightly;
  // in a dev server that only costs a re-evaluation, never correctness.
  const invalidateImporterClosure = (path: string): void => {
    const graph = vite.moduleGraph
    if (graph === undefined) return
    const roots = graph.getModulesByFile(path)
    if (roots === undefined) return
    const seen = new Set<ViteModuleNode>()
    const stack = [...roots]
    for (let mod = stack.pop(); mod !== undefined; mod = stack.pop()) {
      if (seen.has(mod)) continue
      seen.add(mod)
      graph.invalidateModule(mod)
      for (const importer of mod.importers) stack.push(importer)
    }
  }

  // Re-create the app on change so a hard reload picks up a route ADD/REMOVE (the manifest comes
  // from a directory scan, which `ssrLoadModule` cannot invalidate). Module CONTENT is re-evaluated by
  // Vite plus the importer-closure invalidation above; no version counter against Bun's import cache is
  // needed anymore, the way the old `importQuery` cache-buster was.
  let refreshVersion = 0
  const refreshApp = (path?: string): void => {
    if (path !== undefined) invalidateImporterClosure(path)
    const version = ++refreshVersion
    Promise.resolve(options.createApp(entryUrl, ssrLoad))
      .then((next) => {
        if (version === refreshVersion) app = next
      })
      .catch((err) => console.error("[nifra/web/vite] app re-create failed:", err))
  }
  vite.watcher.on("change", refreshApp)
  for (const event of ["add", "unlink"] as const) {
    vite.watcher.on(event, (path) => {
      if (path.startsWith(`${routesDir}/`) || path.startsWith(`${routesDir}\\`)) writeClientEntry()
      refreshApp(path)
    })
  }

  try {
    await listenOrExplain(server, port, "127.0.0.1")
  } catch (err) {
    // Nothing is listening, but Vite is fully up by now - watchers, the dep optimizer, its own sockets -
    // and every one of those keeps the event loop alive. Left open, the process prints the diagnosis and
    // then HANGS on it, which is worse than the raw crash this guard replaced: the user sees a dev server
    // that appears to be starting. Tear Vite down so the failure is terminal.
    await vite.close().catch(() => {})
    throw err
  }
  // Report the port actually BOUND, not the one requested. They differ for `port: 0`, which is how you
  // ask the OS for a free one - the correct thing to do in a test or when running several apps at once.
  // Echoing the request back would return a literal 0, which connects to nothing.
  const address = server.address()
  return {
    port: typeof address === "object" && address !== null ? address.port : port,
    stop: async () => {
      // Cleared with the server that owns it: the slot is process-global, so a stopped server leaving
      // its loader behind would hand the next one's adapter a graph that is closed (tests start and
      // stop several dev servers in one process).
      setSsrModuleLoader(undefined)
      server.close()
      await vite.close()
    },
  }
}
