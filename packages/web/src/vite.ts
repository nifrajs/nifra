/**
 * `@nifrajs/web/vite` — a **dev-only** server with true HMR, backed by Vite in middleware mode. nifra's
 * production pipeline stays Bun-native (`@nifrajs/web/build` → `Bun.build`); this is purely for the dev
 * loop. Bun's own HMR is dev-server-only and DCE's `import.meta.hot` under `Bun.build` (nifra's bundler),
 * so HMR comes from Vite + the framework's official Vite plugin (React Fast Refresh, Vue/Svelte/Solid
 * HMR) — which you inject via `plugins` (the same structural-injection idiom as the Bun/codec plugins).
 *
 * Flow: Vite serves + HMR-swaps the client modules (nifra's codegen'd entry + the route files); nifra
 * still **SSRs** each request, and the rendered HTML is run through `vite.transformIndexHtml` so Vite
 * injects its HMR client + the framework's refresh preamble. Node `http` (not `Bun.serve`) because
 * Vite's `middlewares` are Connect-style — it runs fine under Bun.
 */
import { writeFileSync } from "node:fs"
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { relative, resolve as resolvePath } from "node:path"
import { renderDevErrorOverlay } from "./dev-error.ts"
import { discoverRoutes } from "./fs.ts"
import { DEFAULT_DEV_PORT, generateClientEntry } from "./index.ts"

/** Minimal app surface — `createWebApp(...)` satisfies it. */
interface FetchApp {
  fetch(request: Request): Response | Promise<Response>
}

// Structural slice of the Vite dev server this module drives (avoids a hard type dep on `vite`).
interface ViteLike {
  /** Load a module through VITE's graph - the seam that makes the Vite pipeline own SSR too. */
  ssrLoadModule(url: string): Promise<Record<string, unknown>>
  readonly middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void
  transformIndexHtml(url: string, html: string): Promise<string>
  ssrFixStacktrace(err: Error): void
  readonly watcher: { on(event: "change", cb: (path: string) => void): void }
  close(): Promise<void>
}
interface ViteModule {
  createServer(config: Record<string, unknown>): Promise<ViteLike>
  // Present only on rolldown-vite (Vite 8+); used to gate the optimizeDeps.jsx-key normalization below.
  readonly rolldownVersion?: string
}

// `node:http` server type the request handler runs on (also the HMR WebSocket host — see below).
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
  /** Vite plugins — inject your framework's official plugin, e.g. `[react()]`. */
  readonly plugins?: readonly unknown[]
  /**
   * Extra `resolve.conditions` prepended ahead of nifra's defaults — some frameworks need their own
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
   * containers, networked filesystems, and some sandboxes — there, HMR silently never fires. Set
   * `true` (or the env var `CHOKIDAR_USEPOLLING=1`) to poll instead. Default: off (native events).
   */
  readonly poll?: boolean
}

export interface ViteDevServer {
  readonly port: number
  stop(): Promise<void>
}

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
// ordering (`order: "pre" | "post"`). We wrap the handler in either shape — see normalizeRolldownPlugins.
type ConfigFn = (config: unknown, env: unknown) => unknown
type ConfigHook = ConfigFn | { readonly handler: ConfigFn; readonly order?: unknown }

// A Vite plugin — the only hook we wrap is `config`. Typed structurally (no `vite` type dep). Everything
// else on the plugin object is preserved by spread, so wrapping is transparent to Vite.
interface VitePluginLike {
  readonly name?: string
  config?: ConfigHook
  readonly [key: string]: unknown
}

/** The bits of a Node ServerResponse `pipeWebBodyToNode` touches — structural, to avoid a node:http dep here. */
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
 * `Headers` iterator (and `.get`) join multiple set-cookie values with ", ", which corrupts cookies — e.g.
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
 * `arrayBuffer()`) waits for the stream to END — which an open-ended SSE (`text/event-stream`) body never
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
    // client disconnected mid-stream — the `close` handler already cancelled the reader
  }
  res.end()
}

/**
 * Strip `optimizeDeps.rollupOptions.jsx` from a plugin's `config` hook output when running under
 * rolldown-vite — the source of the scary, harmless `Warning: Invalid input options … "jsx" Invalid
 * key: Expected never but received "jsx"` on `nifra dev`.
 *
 * Why it happens: `@vitejs/plugin-react@4.x` (and peers) target an *older* rolldown-vite optimizeDeps
 * API — they inject `optimizeDeps.rollupOptions.jsx` to tell the dep pre-bundler to transform JSX. Vite
 * 8's rolldown dep-optimizer renamed that surface to `optimizeDeps.rolldownOptions` (and moved jsx under
 * `transform.jsx`), so the stale `rollupOptions.jsx` is an unrecognized input option → the warning. It's
 * a version-skew artifact, not a real misconfig: the route source JSX transform runs through the
 * plugin's own `transform` hook (untouched here), and node_modules deps that get pre-bundled almost
 * never contain raw JSX — so dropping the dead key changes no behavior and keeps HMR/Fast Refresh
 * intact. We *strip* (rather than translate to `rolldownOptions`) so the fix is version-agnostic: a
 * plugin already emitting the correct `rolldownOptions` is left untouched, and a future plugin bump that
 * stops emitting `rollupOptions.jsx` makes this a no-op.
 *
 * Scoped narrowly: only the `optimizeDeps.rollupOptions.jsx` key is removed, only under rolldown-vite,
 * and only from the value a plugin's `config` hook returns. Non-rolldown Vite is passed through verbatim.
 *
 * FLATTEN FIRST: a Vite plugin factory may return an ARRAY of plugins — `@vitejs/plugin-react`'s `react()`
 * returns `[vite:react-babel, vite:react-refresh]`, and it's `react:react-babel`'s `config` hook that emits
 * the offending `optimizeDeps.rollupOptions.jsx`. `nifra.config.ts` writes `vitePlugins = [react()]`, so the
 * plugin list arrives NESTED (`[[babel, refresh]]`). Without flattening, `.map` sees the inner array (which
 * has no `config`), leaves it untouched, and Vite — which flattens plugin arrays itself before running them
 * — then executes the un-stripped babel hook, so the warning survives. Flattening here (Vite accepts a flat
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
      // The hook may return a promise — normalize both shapes.
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

/** The bits of a Node server {@link listenOrExplain} touches — structural, so a test can fake it. */
interface ListenTarget {
  listen(port: number, cb: () => void): void
  once(event: "error", cb: (err: unknown) => void): void
  removeListener(event: "error", cb: (err: unknown) => void): void
}

/** The `EADDRINUSE` explanation. Exported so the test asserts the exact text a user will read. */
export function portInUseMessage(port: number): string {
  return (
    `[nifra] dev server can't start: port ${port} is already in use.\n` +
    `  Most likely an earlier \`nifra dev\` is still running. It keeps serving the PREVIOUS build, so ` +
    `every edit will look like it stops reaching SSR while the browser shows stale output.\n` +
    `  Free the port:  lsof -ti:${port} | xargs kill\n` +
    `  Or use another: nifra dev --port ${port + 1}`
  )
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/**
 * `listen`, but a bind failure becomes a readable nifra error instead of Node's raw internal throw.
 *
 * The message matters more than the tidier stack. When the port is taken, the OLD dev server is still
 * answering on it - so the next request returns the previous build of every route. The symptom is "my
 * edits stopped reaching SSR", which reads as a broken HMR/invalidation bug and sends you digging
 * through the module graph instead of at the one line that says the new server never started. Without
 * an `error` listener Node throws from deep inside `node:events`, the new process dies in the
 * background, and nothing connects that death to the stale page in front of you.
 */
export function listenOrExplain(server: ListenTarget, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: unknown): void => {
      const code = (err as { code?: unknown } | null)?.code
      reject(code === "EADDRINUSE" ? new Error(portInUseMessage(port)) : asError(err))
    }
    server.once("error", onError)
    server.listen(port, () => {
      // Drop the guard once we're listening: leaving it attached would funnel a LATER server error into
      // an already-settled promise, silently swallowing it instead of surfacing it.
      server.removeListener("error", onError)
      resolve()
    })
  })
}

/**
 * Start the Vite-backed dev server: Vite serves/HMRs the client; nifra SSRs each request and Vite
 * injects its HMR client + the framework refresh preamble via `transformIndexHtml`.
 */
export async function createViteDevServer(options: ViteDevServerOptions): Promise<ViteDevServer> {
  const root = resolvePath(options.root ?? process.cwd())
  const routesDir = resolvePath(options.routesDir)
  const port = options.port ?? DEFAULT_DEV_PORT

  // Codegen the client entry with Vite-servable, root-relative specifiers (e.g. `/routes/index.tsx`).
  const manifest = discoverRoutes(routesDir)
  const toUrl = (file: string): string => `/${relative(root, `${routesDir}/${file}`)}`
  writeFileSync(
    resolvePath(root, DEV_ENTRY),
    generateClientEntry(manifest, { clientModule: options.clientModule, resolve: toUrl }),
  )
  const entryUrl = `/${DEV_ENTRY}`

  // Create our HTTP server FIRST, then hand it to Vite as the HMR WebSocket host (`hmr.server`). In
  // middleware mode Vite would otherwise open a *separate* ws port (24678) — fragile: it conflicts
  // across restarts ("Port undefined is already in use" → the client never connects). Sharing one
  // port means HMR rides the same origin as the app, robust across restarts. The handler closes over
  // `vite`, which is assigned just below before the server starts listening.
  let vite!: ViteLike
  let app: FetchApp

  const server: NodeHttpServer = createHttpServer((req, res) => {
    vite.middlewares(req, res, () => {
      // Not a Vite asset → nifra SSR. (`next` runs after Vite declines, so the body is still readable.)
      void (async () => {
        try {
          const body = await readNodeBody(req)
          const nifraRes = await app.fetch(toWebRequest(req, body))
          const contentType = nifraRes.headers.get("content-type") ?? ""
          res.statusCode = nifraRes.status
          if (!contentType.includes("text/html")) {
            // Data / redirect / asset response — pass through untouched, streamed (SSE-safe). Set-Cookie is
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
          // the readable dev overlay instead of a bare text dump. Dev-only — production maps to `_error`.
          if (err instanceof Error) vite.ssrFixStacktrace(err)
          res.statusCode = 500
          res.setHeader("content-type", "text/html; charset=utf-8")
          res.end(renderDevErrorOverlay(err, { method: req.method ?? "GET", url: req.url ?? "/" }))
        }
      })()
    })
  })

  // `conditions: ["bun"]` makes Vite resolve nifra's workspace packages (`@nifrajs/web-react/client`, …) to
  // their TS **source** — so the dev server needs no prior `dist` build of the adapter packages.
  const usePolling = options.poll ?? process.env.CHOKIDAR_USEPOLLING === "1"
  const viteModule = (await import("vite")) as unknown as ViteModule
  const { createServer } = viteModule
  // Under rolldown-vite (Vite 8+), strip the stale `optimizeDeps.rollupOptions.jsx` some framework
  // plugins still emit — it triggers a noisy "Invalid key … jsx" warning but does nothing useful here.
  const plugins = normalizeRolldownPlugins(
    options.plugins ?? [],
    viteModule.rolldownVersion !== undefined,
  )
  vite = await createServer({
    root,
    appType: "custom",
    server: {
      middlewareMode: true,
      hmr: { server },
      // Explicit watch config; poll when native fs events aren't delivered (containers/sandboxes).
      watch: usePolling ? { usePolling: true, interval: 80 } : {},
    },
    plugins: [...plugins],
    resolve: {
      conditions: [...(options.conditions ?? []), "bun", "module", "browser", "development"],
      // Dedupe React to ONE copy. In a multi-root workspace a shared package can pull react/react-dom
      // from a SIBLING app's node_modules, so the dev server loads two React cores → a second hook
      // dispatcher → `resolveDispatcher().useState` null on any hook-using route (the error points at the
      // component, not the resolution — brutal to diagnose). Mirrors the build-time reactDedupePlugin so
      // dev matches prod. No-op for non-React apps (the package simply isn't present to dedupe).
      dedupe: ["react", "react-dom"],
    },
    ...(options.define ? { define: options.define } : {}),
  })

  const ssrLoad = (absolutePath: string): Promise<unknown> => vite.ssrLoadModule(absolutePath)
  app = await options.createApp(entryUrl, ssrLoad)

  // Re-create the app on change so a hard reload picks up a route ADD/REMOVE (the manifest comes
  // from a directory scan, which `ssrLoadModule` cannot invalidate). Module CONTENT no longer needs a
  // version counter: Vite owns SSR resolution now and re-evaluates changed modules itself, which is
  // the cache-busting the old `importQuery` was emulating against Bun's import cache.
  vite.watcher.on("change", () => {
    Promise.resolve(options.createApp(entryUrl, ssrLoad))
      .then((next) => {
        app = next
      })
      .catch((err) => console.error("[nifra/web/vite] app re-create failed:", err))
  })

  try {
    await listenOrExplain(server, port)
  } catch (err) {
    // Nothing is listening, but Vite is fully up by now - watchers, the dep optimizer, its own sockets -
    // and every one of those keeps the event loop alive. Left open, the process prints the diagnosis and
    // then HANGS on it, which is worse than the raw crash this guard replaced: the user sees a dev server
    // that appears to be starting. Tear Vite down so the failure is terminal.
    await vite.close().catch(() => {})
    throw err
  }
  return {
    port,
    stop: async () => {
      server.close()
      await vite.close()
    },
  }
}
