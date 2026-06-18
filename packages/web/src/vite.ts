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
import { generateClientEntry } from "./index.ts"

/** Minimal app surface — `createWebApp(...)` satisfies it. */
interface FetchApp {
  fetch(request: Request): Response | Promise<Response>
}

// Structural slice of the Vite dev server this module drives (avoids a hard type dep on `vite`).
interface ViteLike {
  readonly middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void
  transformIndexHtml(url: string, html: string): Promise<string>
  ssrFixStacktrace(err: Error): void
  readonly watcher: { on(event: "change", cb: (path: string) => void): void }
  close(): Promise<void>
}
interface ViteModule {
  createServer(config: Record<string, unknown>): Promise<ViteLike>
}

// `node:http` server type the request handler runs on (also the HMR WebSocket host — see below).
type NodeHttpServer = ReturnType<typeof createHttpServer>

export interface ViteDevServerOptions {
  /** Absolute (or cwd-relative) path to the `routes/` dir. */
  readonly routesDir: string
  /** Client runtime module providing `mountRouter` (e.g. `"@nifrajs/web-react/client"`). */
  readonly clientModule: string
  /**
   * Build the nifra app for the given dev client-entry URL. `importQuery` changes when a route file
   * changes — thread it into `discoverRoutes(routesDir, { importQuery })` so a hard reload SSRs edited
   * modules (HMR handles the live client update; this keeps server-render fresh).
   */
  readonly createApp: (clientEntry: string, importQuery: string) => FetchApp | Promise<FetchApp>
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
  /** Port (default 3000). */
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

/**
 * Start the Vite-backed dev server: Vite serves/HMRs the client; nifra SSRs each request and Vite
 * injects its HMR client + the framework refresh preamble via `transformIndexHtml`.
 */
export async function createViteDevServer(options: ViteDevServerOptions): Promise<ViteDevServer> {
  const root = resolvePath(options.root ?? process.cwd())
  const routesDir = resolvePath(options.routesDir)
  const port = options.port ?? 3000

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
  let version = 0
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
            // Data / redirect / asset response — pass through untouched.
            for (const [key, value] of nifraRes.headers) res.setHeader(key, value)
            res.end(Buffer.from(await nifraRes.arrayBuffer()))
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
  const { createServer } = (await import("vite")) as unknown as ViteModule
  vite = await createServer({
    root,
    appType: "custom",
    server: {
      middlewareMode: true,
      hmr: { server },
      // Explicit watch config; poll when native fs events aren't delivered (containers/sandboxes).
      watch: usePolling ? { usePolling: true, interval: 80 } : {},
    },
    plugins: [...(options.plugins ?? [])],
    resolve: {
      conditions: [...(options.conditions ?? []), "bun", "module", "browser", "development"],
    },
    ...(options.define ? { define: options.define } : {}),
  })

  app = await options.createApp(entryUrl, `v=${version}`)

  // Keep server-render fresh on edits (Vite already HMRs the client live; this is for a hard reload).
  vite.watcher.on("change", () => {
    version += 1
    Promise.resolve(options.createApp(entryUrl, `v=${version}`))
      .then((next) => {
        app = next
      })
      .catch((err) => console.error("[nifra/web/vite] app re-create failed:", err))
  })

  await new Promise<void>((done) => server.listen(port, done))
  return {
    port,
    stop: async () => {
      server.close()
      await vite.close()
    },
  }
}
