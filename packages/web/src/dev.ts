/**
 * `@nifrajs/web/dev` — the **Bun pipeline's** dev server: one toolchain, no Vite in the process.
 *
 * nifra ships two dev pipelines and the rule between them is that a pipeline owns a whole phase. The
 * Vite server (`@nifrajs/web/vite`) is the default - mature framework plugins, and it resolves SSR as
 * well as the client so both halves agree on every specifier. This is the other one: `Bun.serve` bundles
 * and hot-reloads the client while Bun's runtime resolves SSR. Only one toolchain is present, so the two
 * cannot disagree.
 *
 * What you get: React Fast Refresh WITH state preserved — Bun's dev server applies it natively, no plugin
 * (verified: editing a component-only module swaps its markup while a `useState` counter keeps its value,
 * no reload). The usual boundary rule still applies, and it is the same rule Vite has: a module whose
 * exports are all components is a refresh boundary, so a ROUTE file that also exports `loader`/`meta` is
 * not, and saving it does a clean full reload. Plus no Vite dependency and ONE bundler across dev and
 * production, which is the real prize — the dev/prod seam disappears.
 *
 * What you give up: `*.module.css`. Bun's DEV-server bundler has no CSS-Modules transform (its production
 * `Bun.build` does), so the import compiles to a dangling reference. Plain CSS and Tailwind are fine. The
 * CLI refuses `nifra dev --bun` for a CSS-Modules app rather than serving a broken client.
 *
 * ## How the two halves meet
 *
 * Bun's dev server bundles HTML routes. nifra renders the document itself, so there is no HTML file for
 * Bun to rewrite - pages are produced per request by `createWebApp`. The join is a throwaway HTML route
 * that exists only so Bun bundles the generated client entry and assigns it a hashed URL. nifra reads
 * that URL back out (`./bun-dev-entry.ts`); Bun serves the chunk, and its HMR client - bundled into that
 * same chunk - connects from nifra's pages exactly as it would from Bun's own.
 *
 * What pages actually reference is {@link CLIENT_ENTRY_PATH}, a stable nifra URL that redirects to the
 * current chunk, because Bun's URL is a content hash over the whole client graph and moves on every
 * rebuild. Injecting a remembered one is not a stale-cache annoyance but a hard failure: Bun answers a
 * superseded chunk URL with a `location.reload()` stub, so the page reloads, SSR hands it the same dead
 * URL, and it loops forever with no console output surviving to explain it.
 *
 * The stylesheets come across the same way, and they are the reason that probe page is read for more than
 * a script URL: Bun lifts `import "./app.css"` out of the JS graph and links it from the page IT bundled.
 * That page is the throwaway. Carry the links over or the whole dev session renders unstyled while
 * production, which reads CSS from the build manifest, is perfectly fine.
 *
 * SSR invalidation is Bun's import cache rather than Vite's module graph, so route modules are re-imported
 * under a changing query on each change - which is what `discoverRoutes({ importQuery })` exists for.
 *
 * Bun-only + build-time; never imported by the edge runtime.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { type BuildClientOptions, buildClient } from "./build.ts"
import { type DevEntryMatch, resolveDevEntry } from "./bun-dev-entry.ts"
import { renderDevErrorOverlay } from "./dev-error.ts"
import { explainBindFailure } from "./dev-port.ts"
import { discoverRoutes } from "./fs.ts"
import { DEFAULT_DEV_PORT, generateClientEntry } from "./index.ts"
import { servePublicDir } from "./public-dir.ts"

/** Minimal app surface the dev server needs — `createWebApp(...)` satisfies it. */
interface FetchApp {
  fetch(request: Request): Response | Promise<Response>
}

export interface DevServerOptions extends Omit<BuildClientOptions, "minify"> {
  /**
   * Build the nifra app for the current client entry. `importQuery` changes on every reload — pass it to
   * `discoverRoutes(routesDir, { importQuery })` so SSR re-imports edited route modules instead of Bun's
   * cached copies.
   */
  readonly createApp: (clientEntry: string, importQuery: string) => FetchApp | Promise<FetchApp>
  /** Directories to watch (default: `[routesDir]`). */
  readonly watch?: readonly string[]
  /** Port to listen on (default {@link DEFAULT_DEV_PORT}). */
  readonly port?: number
  /** Directory of user-authored static files served at the root (default `"public"`). The SAME
   * option the production build copies and serves, so dev and prod cannot drift. */
  readonly publicDir?: string | false
  /**
   * Run the client-leak guards on each change (default `true`).
   *
   * `buildClient` is what runs them - server-only code reaching the browser, `node:` builtins in client
   * code - and Bun's dev server does its own bundling, so nothing would run them otherwise. They are
   * security guards; a dev loop that stops enforcing them is how a leak reaches a deploy unnoticed. The
   * pass runs in the background off the hot path, so HMR is never waiting on it, and only reports.
   */
  readonly guardLeaks?: boolean
}

export interface DevServer {
  readonly port: number
  /**
   * The URL pages point their client entry at — always {@link CLIENT_ENTRY_PATH}, never Bun's hashed
   * chunk. Deliberately not the underlying chunk URL: that one moves on every rebuild, and anything
   * holding onto it is holding onto a URL that will stop working.
   */
  readonly clientEntry: string
  stop(): void
}

/**
 * Where the generated dev files live. A dot-directory inside the project, not a temp dir: Bun's bundler
 * resolves the entry's imports the way the runtime does, so it has to sit where the app's routes and
 * `node_modules` are reachable from.
 */
const DEV_DIR = ".nifra-bun"
/**
 * The throwaway route serving the bundled HTML. Namespaced under `/__nifra/` so it cannot collide with an
 * app route: file-based routing does not produce a leading double underscore.
 */
const PROBE_PATH = "/__nifra/dev-entry"
/**
 * The stable URL every SSR'd page points its client entry at.
 *
 * It has to be stable, and Bun's own URL is not: that one is a content hash over the entire client graph,
 * so it changes whenever anything the entry imports changes. This path redirects to whichever hashed
 * chunk Bun is serving at the moment the browser asks, which is the only formulation that stays correct
 * across a rebuild.
 */
export const CLIENT_ENTRY_PATH = "/__nifra/client.js"

/** Bun's `HTMLBundle` is opaque at the type level; it is only ever handed straight back to `Bun.serve`. */
type HtmlBundle = unknown

/** The `Bun.serve` surface this uses, typed structurally so the file builds without Bun's ambient types. */
interface BunServeOptions {
  readonly port: number
  readonly development: { readonly hmr: boolean }
  readonly routes: Record<string, HtmlBundle>
  fetch(request: Request): Promise<Response>
}
interface BunServerHandle {
  readonly port: number
  stop(closeActiveConnections?: boolean): void
}
type BunServe = (options: BunServeOptions) => BunServerHandle

function bunServe(): BunServe {
  const serve = (globalThis as { Bun?: { serve?: unknown } }).Bun?.serve
  if (typeof serve !== "function") {
    throw new Error(
      "[nifra] the Bun dev server needs the Bun runtime (`Bun.serve` is not available here). Run it " +
        "under `bun`, or use the Vite pipeline dev server, which runs on Node's http server.",
    )
  }
  return serve as BunServe
}

/** Write only when the content differs, so an unchanged file's mtime never moves. */
function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, "utf8") === content) return
  } catch {
    // missing or unreadable — fall through and write
  }
  writeFileSync(path, content)
}

/**
 * The throwaway HTML document. Its only job is to make Bun bundle the entry and assign it a URL - it is
 * never shown to a user, so it carries no app markup. The `<div id="root">` is there purely so the
 * document stands on its own if someone opens the probe path directly while debugging.
 */
export function devHtml(entryHref: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>nifra dev entry</title></head><body><div id="root"></div>` +
    `<script type="module" src="${entryHref}"></script></body></html>`
  )
}

interface WriteDevFilesOptions {
  readonly routesDir: string
  readonly clientModule: string
  readonly entryPath: string
  readonly htmlPath: string
}

/**
 * Generate the client entry + the HTML route that carries it.
 *
 * Route specifiers are written **relative to the entry file**, not root-relative as the Vite path writes
 * them: Vite resolves `/routes/x.tsx` against its configured root, while Bun's bundler resolves an import
 * the way the runtime does, so a leading slash there would mean the filesystem root.
 */
export function writeDevFiles(options: WriteDevFilesOptions): void {
  const { routesDir, clientModule, entryPath, htmlPath } = options
  mkdirSync(dirname(entryPath), { recursive: true })
  const manifest = discoverRoutes(routesDir)
  const entryDir = dirname(entryPath)
  const toSpecifier = (file: string): string => {
    const rel = relative(entryDir, `${routesDir}/${file}`).replaceAll("\\", "/")
    // A bare relative path reads as a PACKAGE specifier to a bundler; `./` is what makes it a file.
    return rel.startsWith(".") ? rel : `./${rel}`
  }
  // No `import.meta.hot.accept` here, deliberately. When an edit lands OUTSIDE a Fast Refresh boundary —
  // a route file, which also exports `loader`/`meta` — Bun walks up to this generated entry, finds no
  // `accept`, logs "hot update was not accepted" and does a full reload. That reload is correct: the route
  // module's non-component exports changed, so patching it into the live tree would be wrong. Accepting
  // here is worse than the warning: Bun re-evaluates the module BEFORE the accept callback runs, so the
  // entry re-executes against a container React already mounted ("createRoot() on a container that has
  // already been passed to createRoot()") and only then does the callback get to reload — trading an
  // accurate warning for a real error. Editing a component-only module never reaches this path: Bun
  // applies React Fast Refresh there and state is preserved.
  writeIfChanged(entryPath, generateClientEntry(manifest, { clientModule, resolve: toSpecifier }))
  const entryHref = `./${relative(dirname(htmlPath), entryPath).replaceAll("\\", "/")}`
  writeIfChanged(htmlPath, devHtml(entryHref))
}

/** `<link rel="stylesheet">` tags for Bun's extracted CSS, injected into each SSR'd page's `<head>`. */
export function styleTags(styles: readonly string[]): string {
  let html = ""
  for (const href of styles) {
    // Bun's asset URLs are hashes it generated, not user input; escaping the quote character is still
    // the correct habit at an HTML boundary and costs nothing.
    html += `<link rel="stylesheet" href="${href.replaceAll('"', "&quot;")}">`
  }
  return html
}

/**
 * Inject Bun's stylesheet links into an SSR'd document.
 *
 * Prefers `</head>`; falls back to prepending when a document has no head (a bare fragment from a custom
 * renderer). Never appends blindly at the end - a stylesheet after `</body>` still applies but arrives
 * after first paint, so the page flashes unstyled and dev stops resembling production.
 */
export function injectStyles(html: string, styles: readonly string[]): string {
  if (styles.length === 0) return html
  const tags = styleTags(styles)
  const head = html.indexOf("</head>")
  if (head !== -1) return html.slice(0, head) + tags + html.slice(head)
  return tags + html
}

/** Start the Bun dev server: generate → bundle → serve → watch → hot-reload on change. */
export async function createDevServer(options: DevServerOptions): Promise<DevServer> {
  const { createApp, port = DEFAULT_DEV_PORT, routesDir, clientModule } = options
  const serve = bunServe()
  // The app root. `routesDir` is `<app>/routes` by convention, so its parent is the project - the one
  // place a generated entry can sit and still resolve the app's imports.
  const root = resolve(routesDir, "..")
  const devDir = resolve(root, DEV_DIR)
  const entryPath = resolve(devDir, "entry.tsx")
  const htmlPath = resolve(devDir, "entry.html")
  const publicDir = options.publicDir === false ? undefined : (options.publicDir ?? "public")
  // Route dev's `public/` through the SAME handler production uses. Dev previously inherited this
  // from Vite implicitly while production had no equivalent, which is the entire bug: two code paths
  // with different defaults, so a file worked in dev and 404'd only once deployed.
  const servePublic =
    publicDir === undefined
      ? async (): Promise<undefined> => undefined
      : servePublicDir({ dir: resolve(publicDir) })

  writeDevFiles({ routesDir, clientModule, entryPath, htmlPath })
  // Importing the generated HTML is what hands it to Bun's bundler. A runtime-computed path is fine:
  // Bun resolves and bundles the HTML, and everything it references, at import time.
  const htmlModule = (await import(htmlPath)) as { default: HtmlBundle }

  let server: BunServerHandle
  // The last resolved entry, with the time it was resolved. Deliberately short-lived — see `currentEntry`.
  let cache: { readonly entry: DevEntryMatch; readonly at: number } | undefined
  // The app, tagged with the entry hash it was built against — see `appFor`.
  let built: { readonly entry: string; readonly app: FetchApp } | undefined
  let building: { readonly entry: string; readonly promise: Promise<FetchApp> } | undefined
  let version = 0

  /**
   * The client entry Bun is serving RIGHT NOW.
   *
   * Bun's entry URL is a content hash over the whole client graph, so any file it reaches re-hashes it.
   * Resolving once at startup and injecting that value forever is the trap this exists to avoid: Bun
   * answers a superseded chunk URL with a `location.reload()` stub, the page reloads, SSR hands it the
   * same dead URL, and it reloads again - an invisible infinite loop, because each reload wipes the
   * console that would have explained it.
   *
   * Re-resolving cannot be driven off the file watcher either. The watcher covers `routesDir`; the client
   * graph includes components, styles and anything else a route imports, so an edit outside the watched
   * tree would re-hash the entry with nothing to notice. Asking the dev server is the only answer that is
   * right by construction.
   *
   * The TTL keeps that honest without making it expensive: a page render probes fresh (`force`), and the
   * client-entry request that follows it milliseconds later reads the same cached answer - so the HTML and
   * the script it points at always come from ONE probe, and cannot describe different builds.
   */
  const ENTRY_TTL_MS = 250
  const currentEntry = async (force = false): Promise<DevEntryMatch> => {
    const now = performance.now()
    if (!force && cache !== undefined && now - cache.at < ENTRY_TTL_MS) return cache.entry
    const entry = await resolveDevEntry(server, { probePath: PROBE_PATH })
    cache = { entry, at: now }
    return entry
  }

  /**
   * The app built against the client Bun is currently serving.
   *
   * SSR freshness cannot be driven off the file watcher, and getting this wrong is subtle enough to be
   * worth stating. Bun rebuilds the client and tells the browser to reload the instant a file is saved;
   * the watcher here is `watchFile` mtime polling, a poll interval plus a debounce behind that. So the
   * browser's reload request lands while SSR is still rendering the previous code - the server sends the
   * old markup, the client boots the new module, and React reports a hydration mismatch and throws the
   * server-rendered tree away. Transient, self-correcting on the next reload, and exactly the kind of
   * dev-only weirdness nobody can reproduce on request.
   *
   * Ordering by request instead of by clock removes the race rather than shrinking it. Bun's entry hash is
   * a content hash over the whole client graph, so it IS the version marker - and it is already being
   * fetched to render the page. Rebuilding when it moves means SSR is, by construction, never behind the
   * client that is about to hydrate it.
   *
   * The watcher still runs: it regenerates the entry when routes are added or removed, and re-checks for
   * client leaks. It is no longer what keeps SSR correct.
   */
  const appFor = (entrySrc: string): Promise<FetchApp> => {
    if (built?.entry === entrySrc) return Promise.resolve(built.app)
    if (building?.entry === entrySrc) return building.promise
    version += 1
    const promise = Promise.resolve(createApp(CLIENT_ENTRY_PATH, `v=${version}`))
    building = { entry: entrySrc, promise }
    void promise
      .then((next) => {
        if (building?.entry === entrySrc) {
          built = { entry: entrySrc, app: next }
          building = undefined
        }
      })
      .catch(() => {
        // Clear the in-flight marker so the next request retries instead of re-awaiting a failed build.
        if (building?.entry === entrySrc) building = undefined
      })
    return promise
  }

  try {
    server = serve({
      port,
      development: { hmr: true },
      // The probe route is the ONLY path Bun owns; everything else falls through to nifra's SSR.
      routes: { [PROBE_PATH]: htmlModule.default },
      fetch: async (req: Request): Promise<Response> => {
        const url = new URL(req.url)
        // The stable client-entry URL. Pages reference THIS; it redirects to whichever hashed chunk Bun
        // is serving at the moment the browser asks. A redirect rather than a proxy so the module's final
        // URL is Bun's own - its HMR client derives its socket and module identity from `import.meta.url`,
        // and serving the bytes under a nifra path would quietly change both.
        if (url.pathname === CLIENT_ENTRY_PATH) {
          // Not forced: this lands right after the page render that just probed, so it reads that same
          // answer and the document and its script are guaranteed to describe one build.
          const entry = await currentEntry()
          return new Response(null, { status: 307, headers: { location: entry.src } })
        }
        // Static probe before routing; a miss returns undefined and falls through, so no route is
        // shadowed and a page render never pays a filesystem stat (extension-less paths skip it).
        const staticFile = await servePublic(req)
        if (staticFile !== undefined) return staticFile
        try {
          // One fresh probe per request: it is both the freshness check for SSR and the stylesheet list,
          // so the page cannot be rendered against a build the browser is not about to load.
          const entry = await currentEntry(true)
          const res = await (await appFor(entry.src)).fetch(req)
          if (!(res.headers.get("content-type") ?? "").includes("text/html")) return res
          if (entry.styles.length === 0) return res
          const headers = new Headers(res.headers)
          headers.delete("content-length") // the body grows with the injected stylesheet links
          return new Response(injectStyles(await res.text(), entry.styles), {
            status: res.status,
            headers,
          })
        } catch (err) {
          return new Response(
            renderDevErrorOverlay(err, {
              method: req.method,
              url: `${url.pathname}${url.search}`,
            }),
            { status: 500, headers: { "content-type": "text/html; charset=utf-8" } },
          )
        }
      },
    })
  } catch (err) {
    // `Bun.serve` throws synchronously on a bind failure; the Vite path's equivalent arrives as an async
    // `error` event. Same explanation either way - see ./dev-port.ts for why it is worth spelling out.
    throw explainBindFailure(err, port)
  }

  try {
    // Build once up front so a dev server that cannot find the entry, or whose app fails to construct,
    // fails at startup with a real diagnosis instead of on the first page request.
    await appFor((await currentEntry()).src)
  } catch (err) {
    // Leaving the server up would answer 500s forever, which presents as a running server rather than as
    // the startup failure it is.
    server.stop(true)
    throw err
  }

  const guard = options.guardLeaks !== false ? leakGuard(options) : undefined
  guard?.()

  // What is left for the watcher, now that request ordering keeps SSR fresh: regenerate the client entry
  // when routes are ADDED or REMOVED (a scan result the request path never re-derives), and re-run the
  // leak guards. The entry is rewritten only when the generated source actually differs - an edit inside
  // an existing route does not change it, and rewriting unconditionally would touch the file Bun watches
  // on every save and turn every hot update into a full client rebuild.
  let timer: ReturnType<typeof setTimeout> | undefined
  const onChange = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        writeDevFiles({ routesDir, clientModule, entryPath, htmlPath })
      } catch (err) {
        // A half-saved file can fail the scan mid-edit; the next change re-runs this.
        console.error("[nifra/web/dev] client entry regeneration failed:", err)
      }
      guard?.()
    }, 60)
  }
  // Poll file mtimes for content and rescan directory membership for add/remove. `watchFile` cannot
  // discover a path that did not exist at startup, so the bounded topology scan owns that gap.
  const watchRoots = options.watch ?? [routesDir]
  const watched = new Set<string>()
  const scan = (): Set<string> => {
    const next = new Set<string>()
    for (const dir of watchRoots) {
      let files: string[]
      try {
        files = readdirSync(dir, { recursive: true }) as string[]
      } catch {
        continue
      }
      for (const file of files) {
        if (/\.(tsx|jsx|ts|js|mdx|svelte|vue)$/.test(file)) next.add(`${dir}/${file}`)
      }
    }
    return next
  }
  const syncWatchedFiles = (notify: boolean): void => {
    const next = scan()
    let topologyChanged = false
    for (const file of watched) {
      if (next.has(file)) continue
      unwatchFile(file)
      watched.delete(file)
      topologyChanged = true
    }
    for (const file of next) {
      if (watched.has(file)) continue
      watched.add(file)
      watchFile(file, { interval: 150 }, onChange)
      topologyChanged = true
    }
    if (notify && topologyChanged) onChange()
  }
  syncWatchedFiles(false)
  const topologyTimer = setInterval(() => syncWatchedFiles(true), 150)
  topologyTimer.unref?.()

  return {
    port: server.port ?? port,
    clientEntry: CLIENT_ENTRY_PATH,
    stop: () => {
      if (timer) clearTimeout(timer)
      clearInterval(topologyTimer)
      for (const file of watched) unwatchFile(file)
      server.stop(true)
      rmSync(devDir, { recursive: true, force: true })
    },
  }
}

/**
 * A debounced, background client-leak check.
 *
 * Bun's dev server does its own bundling, so `buildClient` - which is where `detectServerOnlyInClient`
 * and `detectNodeBuiltinsInClient` run - is no longer on the path that serves the app. Running it beside
 * the dev loop keeps the guards enforced without HMR ever waiting on a full bundle. It only reports:
 * failing the dev server on a leak would mean an in-progress edit can take the whole server down, and
 * the build already blocks the actual deploy.
 *
 * Overlapping runs are collapsed - a save during a bundle queues exactly one re-run, so a burst of edits
 * cannot pile up builds behind each other.
 */
function leakGuard(options: DevServerOptions): () => void {
  let running = false
  let queued = false
  const run = (): void => {
    if (running) {
      queued = true
      return
    }
    running = true
    buildClient({ ...options, minify: false })
      .catch((err: unknown) => {
        console.error(
          `\n[nifra/web/dev] client-leak guard failed:\n${err instanceof Error ? err.message : String(err)}\n` +
            "  The dev server is still running. This will fail `nifra build`.\n",
        )
      })
      .finally(() => {
        running = false
        if (queued) {
          queued = false
          run()
        }
      })
  }
  return run
}
