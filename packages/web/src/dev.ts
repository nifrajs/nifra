/**
 * `@nifrajs/web/dev` — a zero-config dev server (Bun-only). Builds the client unminified on boot,
 * serves the nifra app + hashed assets, and injects a live-reload client. Watches the routes dir:
 * on change it rebuilds the client and re-creates the app with a fresh `importQuery` (so SSR
 * picks up edited route modules past Bun's import cache), then tells the browser to reload.
 * Bun-only + build-time; never imported by the edge runtime.
 */
import { readdirSync, unwatchFile, watchFile } from "node:fs"
import { type BuildClientOptions, buildClient } from "./build.ts"
import { DEFAULT_DEV_PORT } from "./index.ts"

/** Minimal app surface the dev server needs — `createWebApp(...)` satisfies it. */
interface FetchApp {
  fetch(request: Request): Response | Promise<Response>
}

export interface DevServerOptions extends Omit<BuildClientOptions, "minify"> {
  /**
   * Build the nifra app for the freshly-built client entry. `importQuery` changes on every
   * rebuild — pass it to `discoverRoutes(routesDir, { importQuery })` so SSR re-imports edited
   * route modules instead of Bun's cached copies.
   */
  readonly createApp: (clientEntry: string, importQuery: string) => FetchApp | Promise<FetchApp>
  /** Directories to watch (default: `[routesDir]`). */
  readonly watch?: readonly string[]
  /** Port to listen on (default {@link DEFAULT_DEV_PORT}). */
  readonly port?: number
}

export interface DevServer {
  readonly port: number
  stop(): void
}

const RELOAD_PATH = "/__nifra_dev"
const RELOAD_TOPIC = "reload"
// Live-reload client: reloads on a server "reload" push; reconnects if the socket drops.
const reloadClient = `<script>(()=>{const x=()=>{const w=new WebSocket((location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+"${RELOAD_PATH}");w.onmessage=()=>location.reload();w.onclose=()=>setTimeout(x,500)};x()})()</script>`

/** Start the dev server: build → serve → watch → rebuild + reload on change. */
export async function createDevServer(options: DevServerOptions): Promise<DevServer> {
  const { createApp, port = DEFAULT_DEV_PORT, outDir, routesDir } = options
  const publicPath = options.publicPath ?? "/assets/"
  let version = 0
  const rebuild = async (): Promise<FetchApp> => {
    const manifest = await buildClient({ ...options, minify: false })
    return createApp(manifest.entry, `v=${version}`)
  }
  let app = await rebuild()

  const server = Bun.serve({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === RELOAD_PATH) {
        return srv.upgrade(req) ? undefined : new Response("expected websocket", { status: 426 })
      }
      if (url.pathname.startsWith(publicPath)) {
        const file = Bun.file(`${outDir}/${url.pathname.slice(publicPath.length)}`)
        return (await file.exists())
          ? new Response(file, { headers: { "content-type": "text/javascript; charset=utf-8" } })
          : new Response("Not Found", { status: 404 })
      }
      const res = await app.fetch(req)
      if (!(res.headers.get("content-type") ?? "").includes("text/html")) return res
      const headers = new Headers(res.headers)
      headers.delete("content-length") // the body grows with the injected reload client
      const html = (await res.text()).replace("</body>", `${reloadClient}</body>`)
      return new Response(html, { status: res.status, headers })
    },
    websocket: {
      open: (ws) => ws.subscribe(RELOAD_TOPIC),
      message: () => {},
    },
  })

  // On a route change: rebuild the client, re-create the app with a fresh import cache-buster,
  // then push a reload. Debounced so a burst of saves rebuilds once.
  let timer: ReturnType<typeof setTimeout> | undefined
  const onChange = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      version += 1
      rebuild()
        .then((next) => {
          app = next
          server.publish(RELOAD_TOPIC, "reload")
          console.log(`[nifra/web/dev] rebuilt + reloaded (v${version})`)
        })
        .catch((err) => console.error("[nifra/web/dev] rebuild failed:", err))
    }, 60)
  }
  // Poll the source files for changes. Bun's fs.watch is unreliable here, so watchFile (mtime
  // polling) is used. New files need a restart to be tracked — fine for dev.
  const watched = (options.watch ?? [routesDir]).flatMap((dir) =>
    (readdirSync(dir, { recursive: true }) as string[])
      .filter((file) => /\.(tsx|jsx|ts|js|mdx|svelte|vue)$/.test(file))
      .map((file) => `${dir}/${file}`),
  )
  for (const file of watched) watchFile(file, { interval: 150 }, onChange)

  return {
    port: server.port ?? port,
    stop: () => {
      for (const file of watched) unwatchFile(file)
      server.stop()
    },
  }
}
