#!/usr/bin/env bun
/**
 * `nifra` — the zero-config CLI for a nifra app. Reads `framework.ts` + `backend.ts` + `routes/` from
 * the project root (see {@link loadApp}) and wires the right `@nifrajs/web` entrypoint:
 *
 *   nifra dev      true-HMR dev server (Vite middleware + nifra SSR)        — @nifrajs/web/vite
 *   nifra build    bundle the client (content-hashed) + write manifest.json — @nifrajs/web/build
 *   nifra start    serve the built client + SSR on Bun.serve              — @nifrajs/web
 *
 * Bun-only (it runs the framework's TS + Bun plugins directly). The *output* runs anywhere.
 */
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { inProcessClient } from "@nifrajs/client"
import { createWebApp, DEFAULT_DEV_PORT, type RenderAdapter } from "@nifrajs/web"
import { discoverRoutes } from "@nifrajs/web/fs"
import type { BunPlugin } from "bun"
import { describeProject, describeRoutes } from "./introspect.ts"
import { type LoadedApp, loadApp, resolvePlugins } from "./load.ts"

export interface Flags {
  readonly port: number
  readonly out: string
  readonly poll: boolean
  /** `nifra build --target <t>`: emit a full deploy dir for a target (bun/node/deno/cf-pages/vercel/
   * static) instead of just the client bundle. Undefined ⇒ the legacy client-only build. */
  readonly target?: string
  /** `nifra build --report`: print a per-chunk size + gzip table after the build. */
  readonly report: boolean
}

const HELP = `nifra — zero-config dev/build/start for a nifra app

Usage:
  nifra dev     [--port <n>] [--poll]    Start the true-HMR dev server (Vite). Default port ${DEFAULT_DEV_PORT}.
  nifra build   [--out <dir>]            Bundle the client + write manifest.json.
                [--target <t>] [--report]  With --target, emit a FULL deploy dir for <t>:
                                         bun | node | deno | cf-pages | vercel | static. Packages
                                         buildClient + buildServer (+ prerender for static) so an app
                                         no longer hand-writes build-<target>.ts + _worker.ts +
                                         _routes.json. The server entry is generated from your
                                         framework.ts (adapter) + backend.ts + routes/. --report prints
                                         a per-chunk size + gzip table (biggest first).
  nifra start   [--port <n>] [--out <dir>]  Serve the built app (client + SSR) on Bun. Default port ${DEFAULT_DEV_PORT}.
  nifra context                          Print this project's route INDEX (API + page routes) + conventions
                                         for an AI agent's prompt. Per-route schemas: nifra mcp's
                                         nifra_context (path/kind slice) or nifra routes --json.
  nifra routes  [--json]                 List every route the app serves with its method(s): page
                                         routes (routes/) + the in-process backend's API routes,
                                         marking which API routes are auto-mounted under apiPrefix.
                                         --json for agents (see POST /api/x is/isn't served, not via 405).
  nifra init-agents [--force] [--json]   Retrofit an EXISTING app with the agent-discovery files a new
                                         app ships: .mcp.json + .cursor/mcp.json (register this project's
                                         nifra MCP), CLAUDE.md (MCP-first preamble + @AGENTS.md import),
                                         and a "## MCP server" section in AGENTS.md. No-clobber by
                                         default (skips a file you've customized); --force overwrites the
                                         owned files. AGENTS.md is only appended to, never overwritten.
  nifra mcp                              Start an MCP server (stdio) exposing this project to a coding
                                         agent: nifra_context, nifra_routes (routes+schemas as JSON),
                                         nifra_run (backend), nifra_render (SSR a page), nifra_docs,
                                         nifra_example (verified snippets), nifra_scaffold (route→file),
                                         nifra_check (drift gate + fixes), nifra_doctor (undeclared deps).
  nifra docs-mcp [--port <n>]            Serve the PUBLIC docs MCP over HTTP (nifra_docs + nifra_example) —
                                         self-host on a VPS so any remote agent can learn nifra. Default :8787.
  nifra check   [--json] [--lints-only]  Gate: typecheck + lints (hand-rolled fetch(), untyped client("…"),
                                         server-only imports in routes/). Run as "done"; --json for agents;
                                         --lints-only skips tsc for a near-instant inner-loop pass.
  nifra snapshot [--out <file>]          Write the backend's API contract (routes + schemas) as plain
                                         JSON — the baseline for \`nifra diff\`. Default api-snapshot.json.
  nifra diff    [<baseline>] [--json]    Breaking-change gate: re-snapshot the contract and compare
                                         against the committed baseline. Direction-aware (a new required
                                         request field or a removed response field breaks; widening a
                                         request enum or adding a response field doesn't) and fails
                                         closed. Exits non-zero on any breaking change — run it in CI.
  nifra assure  [--config <file>] [--json]  Route-assurance gate: load nifra.assurance.ts, classify every
                                         reflected backend route, and fail when required enforcement
                                         evidence is missing/forbidden or a route is unclassified.
  nifra capabilities snapshot [--out <file>] [--config <file>]
                                         Write the deterministic, token-only capability lockfile, but
                                         only after provenance + idempotency assurance passes.
  nifra capabilities check [--lockfile <file>] [--config <file>] [--json]
                                         CI gate: fail on raw effect-import bypasses, declaration/evidence
                                         drift, unsafe GET/HEAD writes, idempotency gaps, or lockfile drift.
  nifra manifest emit [--out <file>] [--config <file>] [--sign <key-ref>]
                                         Emit a deterministic route trust artifact after assurance passes;
                                         optionally write an Ed25519 signature via the configured KMS signer.
  nifra manifest diff <before> <after> [--json]
                                         Hash-verify and compare two manifests; fail on contract, assurance,
                                         capability, or response-classification regressions.
  nifra doctor  [--json] [--auto-fix]    Flag packages imported in source but missing from package.json
                                         (resolve at Bun runtime, break tsc + standalone install);
                                         --auto-fix writes safe local-version dependency fixes.
  nifra upgrade <version>                Run the per-release upgrade recipe for <version>: sweep every
                [--write] [--no-verify]  matching dependency pin (preserving ^/~/exact) + apply exact
                [--list] [--json]        import moves across the workspace, then verify with nifra check.
                                         Dry-run by default; --write applies then verifies (--no-verify
                                         to skip). --list shows available targets. Fail-closed on an
                                         unknown version. Deterministic + idempotent.
  nifra port    [--target <t>] [--json]  Portability linter: print a feature × deploy-target capability
                [--ci] [--strict]        matrix (in-memory stores, in-process cron/WebSocket, Bun/Deno
                                         globals, node: builtins) with file:line evidence. --target auto-
                                         detected from build/deploy scripts, wrangler.toml, or vercel config;
                                         --ci (or any --target) exits non-zero when a used feature is
                                         unsupported on the target; --strict also fails on caveats.

Reads nifra.config.ts (adapter + clientModule + plugins; or framework.ts), backend.ts (optional), and
routes/ from the current directory. Run from your project root.

Port: \`dev\` and \`start\` share the default ${DEFAULT_DEV_PORT}. Override with \`--port <n>\` (alias \`-p\`) or the
\`PORT\` env var (\`--port\` wins over \`PORT\`, which wins over the default).`

// Kept in lockstep with packages/cli/package.json by check:publish's version-consistency gate.
const CLI_VERSION = "1.10.0"

// A render adapter + nifra server are opaque to the CLI (it just forwards them); cast at the seam.
const asAdapter = (v: unknown): RenderAdapter => v as RenderAdapter
const asBunPlugins = (v: readonly unknown[]): BunPlugin[] => v as BunPlugin[]
const apiOf = (backend: unknown): { api?: unknown } =>
  backend === undefined ? {} : { api: inProcessClient(backend as never) }

async function dev(app: LoadedApp, flags: Flags): Promise<void> {
  const { plugin } = await import("bun")
  const { createViteDevServer } = await import("@nifrajs/web/vite")
  const { framework: fw, routesDir, cwd, backend } = app
  // nifra SSRs each request by importing the route modules through Bun (not Vite's ssrLoadModule), so
  // `.vue`/`.svelte`/Solid routes need their SSR compile plugin registered on Bun's runtime first —
  // the dev analog of `nifra start`. React/Preact JSX is Bun-native → no server plugins → no-op.
  for (const p of asBunPlugins(await resolvePlugins(fw.serverPlugins))) plugin(p)
  const server = await createViteDevServer({
    root: cwd,
    routesDir,
    clientModule: fw.clientModule,
    plugins: await resolvePlugins(fw.vitePlugins),
    poll: flags.poll,
    port: flags.port,
    ...(fw.conditions ? { conditions: fw.conditions } : {}),
    ...(fw.define ? { define: fw.define } : {}),
    createApp: (clientEntry, importQuery) =>
      createWebApp({
        adapter: asAdapter(fw.adapter),
        manifest: discoverRoutes(routesDir, { importQuery }),
        clientEntry,
        ...apiOf(backend),
      }),
  })
  console.log(`nifra dev → http://localhost:${server.port}`)
}

async function build(app: LoadedApp): Promise<void> {
  const { buildClient } = await import("@nifrajs/web/build")
  const { framework: fw, routesDir, outDir } = app
  const manifest = await buildClient({
    routesDir,
    outDir,
    clientModule: fw.clientModule,
    plugins: asBunPlugins(await resolvePlugins(fw.clientPlugins)),
    define: { "process.env.NODE_ENV": '"production"', ...(fw.define ?? {}) },
    ...(fw.conditions ? { conditions: fw.conditions } : {}),
  })
  console.log(`nifra build → ${outDir} (entry ${manifest.entry}${manifest.css ? ", + css" : ""})`)
}

/**
 * `nifra build --target <t>` — package the engine (buildClient + buildServer + prerender) into one
 * command that emits a full deploy dir, so an app no longer hand-writes build-bun.ts + _worker.ts +
 * _routes.json per target. The adapter is imported from `framework.ts` (the edge-bundlable file — never
 * `nifra.config.ts`, which pulls in Vite plugins), and the backend from `backend.ts` when present;
 * `buildTarget` generates the per-target server entry from those + the app's `routes/`.
 */
async function buildForTarget(app: LoadedApp, target: string, report: boolean): Promise<void> {
  const { buildTarget, isBuildTarget, renderSizeReport, BUILD_TARGETS } = await import(
    "@nifrajs/web/build"
  )
  if (!isBuildTarget(target)) {
    throw new Error(`[nifra] unknown --target "${target}". Valid: ${BUILD_TARGETS.join(", ")}.`)
  }
  const { framework: fw, routesDir, outDir, cwd, backend } = app
  // The server entry must import the adapter from `framework.ts` (edge-safe), not the loaded config.
  // `loadApp` guarantees one of them exists; prefer framework.ts so a multi-target app's Vite-plugin
  // config never reaches the edge bundle (see load.ts module header).
  const frameworkFile = existsSync(resolve(cwd, "framework.ts"))
    ? resolve(cwd, "framework.ts")
    : existsSync(resolve(cwd, "nifra.config.ts"))
      ? resolve(cwd, "nifra.config.ts")
      : resolve(cwd, "framework.ts")
  const backendFile = resolve(cwd, "backend.ts")
  const result = await buildTarget(target, {
    routesDir,
    outDir,
    workDir: resolve(cwd, ".nifra-build"),
    clientModule: fw.clientModule,
    adapterImport: frameworkFile,
    ...(backend !== undefined && existsSync(backendFile) ? { backendImport: backendFile } : {}),
    clientPlugins: asBunPlugins(await resolvePlugins(fw.clientPlugins)),
    serverPlugins: asBunPlugins(await resolvePlugins(fw.serverPlugins)),
    ...(fw.conditions ? { conditions: fw.conditions } : {}),
    ...(fw.define ? { define: fw.define } : {}),
    // The static target needs a built app to drive prerendering — only build it when targeting static.
    ...(target === "static" ? { prerenderApp: await buildPrerenderApp(app) } : {}),
  })
  console.log(`nifra build (${target}) → ${result.run}`)
  if (report) console.log(`\n${renderSizeReport(result.size)}`)
}

/** Build the app FACTORY for the `static` target's prerender pass. Mirrors `nifra start`: register the
 * framework's SSR Bun plugins (so `.vue`/`.svelte`/Solid routes import) once, then return a factory that
 * `createWebApp`s the app for the client build's manifest. The client entry MUST be the real content-hashed
 * bundle (`client.entry`) — it's the hydration `<script src>` the prerendered HTML emits, so a placeholder
 * would 404 and the pages would render but never hydrate (inert controls). Styles/route-preload are wired
 * from the same manifest so the static HTML matches what `nifra start` serves. */
async function buildPrerenderApp(
  app: LoadedApp,
): Promise<(client: BuiltManifest) => { fetch(req: Request): Response | Promise<Response> }> {
  const { plugin } = await import("bun")
  const { framework: fw, routesDir, backend } = app
  for (const p of asBunPlugins(await resolvePlugins(fw.serverPlugins))) plugin(p)
  return (client) =>
    createWebApp({
      adapter: asAdapter(fw.adapter),
      manifest: discoverRoutes(routesDir),
      clientEntry: client.entry,
      ...(client.routes ? { routePreload: client.routes } : {}),
      ...(client.css ? { styles: client.css } : {}),
      ...(client.routeStyles ? { routeStyles: client.routeStyles } : {}),
      ...apiOf(backend),
    })
}

interface BuiltManifest {
  readonly entry: string
  readonly routes?: Readonly<Record<string, readonly string[]>>
  readonly css?: readonly string[]
  readonly routeStyles?: Readonly<Record<string, readonly string[]>>
}

async function start(app: LoadedApp, flags: Flags): Promise<void> {
  const { plugin } = await import("bun")
  const { framework: fw, routesDir, outDir, backend } = app
  // Register the framework's SSR Bun plugins so `.vue`/`.svelte`/Solid route files compile on the
  // server's runtime import (React/Preact JSX is Bun-native → none).
  for (const p of asBunPlugins(await resolvePlugins(fw.serverPlugins))) plugin(p)

  const manifestFile = Bun.file(`${outDir}/manifest.json`)
  if (!(await manifestFile.exists())) {
    throw new Error(`[nifra] no ${outDir}/manifest.json — run \`nifra build\` first.`)
  }
  const manifest = JSON.parse(await manifestFile.text()) as BuiltManifest

  const server = createWebApp({
    adapter: asAdapter(fw.adapter),
    manifest: discoverRoutes(routesDir),
    clientEntry: manifest.entry,
    ...(manifest.routes ? { routePreload: manifest.routes } : {}),
    ...(manifest.css ? { styles: manifest.css } : {}),
    ...(manifest.routeStyles ? { routeStyles: manifest.routeStyles } : {}),
    ...apiOf(backend),
  })
  // Serve the content-hashed bundle (immutable). `.css` → text/css, else JS. Name is path-validated.
  server.get("/assets/*", async (c) => {
    const name = new URL(c.req.url).pathname.slice("/assets/".length)
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("bad request", { status: 400 })
    const file = Bun.file(`${outDir}/${name}`)
    if (!(await file.exists())) return new Response("Not Found", { status: 404 })
    const type = name.endsWith(".css") ? "text/css" : "text/javascript"
    return new Response(file, {
      headers: {
        "content-type": `${type}; charset=utf-8`,
        "cache-control": "public, max-age=31536000, immutable",
      },
    })
  })
  const running = server.listen(flags.port)
  console.log(`nifra start → http://localhost:${running.port}`)
}

export function parseFlags(args: readonly string[]): Flags {
  // Port precedence: `--port`/`-p` (most specific) > `PORT` env > the framework default. The default is
  // the SAME uncommon port for `nifra dev` and `nifra start` (DEFAULT_DEV_PORT) so a project's URL is
  // stable across commands and doesn't collide with the usual 3000/5173/8080 crowd.
  let port = Number(Bun.env.PORT ?? DEFAULT_DEV_PORT)
  let out = "dist"
  let poll = Bun.env.CHOKIDAR_USEPOLLING === "1"
  let target: string | undefined
  let report = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if ((a === "--port" || a === "-p") && args[i + 1]) port = Number(args[++i])
    else if (a === "--out" && args[i + 1]) out = args[++i] as string
    else if (a === "--poll") poll = true
    else if (a === "--target" && args[i + 1]) target = args[++i]
    else if (a === "--report") report = true
  }
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`[nifra] invalid --port: ${port}`)
  }
  return { port, out, poll, report, ...(target !== undefined ? { target } : {}) }
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2)
  const command = argv[0]
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP)
    return
  }
  if (command === "--version" || command === "-v") {
    console.log(`nifra (@nifrajs/cli) ${CLI_VERSION}`)
    return
  }
  // `mcp` runs a long-lived stdio server and loads the project lazily per-tool — it must not go through
  // the eager `loadApp` below (which would fail fast on a project that's API-only / not yet built).
  if (command === "mcp") {
    const { runMcpServer } = await import("./mcp.ts")
    await runMcpServer(process.cwd(), CLI_VERSION)
    return
  }
  // `docs-mcp` runs the PUBLIC docs MCP over HTTP — project-independent (serves the bundled corpus), so
  // it self-hosts anywhere Bun runs (a VPS behind a reverse proxy, a container). Long-lived; no loadApp.
  if (command === "docs-mcp") {
    const { handleMcpHttp } = await import("./mcp-http.ts")
    const portArg = argv[argv.indexOf("--port") + 1]
    const port = Number(portArg && argv.includes("--port") ? portArg : (Bun.env.PORT ?? 8787))
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`[nifra] invalid --port: ${port}`)
    }
    const server = Bun.serve({ port, fetch: handleMcpHttp })
    console.log(`nifra docs MCP (HTTP) → ${server.url}`)
    return
  }
  // `check` is a pure cwd-based gate (typecheck + lint) — it must run even when the project doesn't
  // load (API-only, not built yet), so it dispatches before the eager `loadApp` below.
  if (command === "check") {
    const { runCheck } = await import("./check.ts")
    if (
      !(await runCheck(process.cwd(), {
        json: argv.includes("--json"),
        lintsOnly: argv.includes("--lints-only"),
      }))
    )
      process.exitCode = 1
    return
  }
  // `init-agents` retrofits the agent-discovery files (.mcp.json, CLAUDE.md, …) into the cwd. It's a
  // pure file-writing command independent of the app loading, so dispatch it before the eager `loadApp`
  // (an existing app might be API-only or not yet built). It always succeeds unless a write throws.
  if (command === "init-agents") {
    const { runInitAgents } = await import("./init-agents.ts")
    await runInitAgents(process.cwd(), {
      json: argv.includes("--json"),
      force: argv.includes("--force"),
    })
    return
  }
  // `doctor` is a pure cwd check (imports vs declared deps) — like `check`, dispatch before `loadApp`
  // so it runs on an API-only / not-yet-built project.
  if (command === "doctor") {
    const { runDoctor } = await import("./doctor.ts")
    if (
      !(await runDoctor(process.cwd(), {
        json: argv.includes("--json"),
        autoFix: argv.includes("--auto-fix") || argv.includes("--fix"),
      }))
    )
      process.exitCode = 1
    return
  }
  // `snapshot` / `diff` load ONLY backend.ts (the API contract) — like `check`, they must run on an
  // API-only project, so they dispatch before the eager `loadApp`.
  if (command === "snapshot") {
    const { runSnapshot } = await import("./diff-tool.ts")
    const outIdx = argv.indexOf("--out")
    const out = outIdx !== -1 ? argv[outIdx + 1] : undefined
    if (outIdx !== -1 && (out === undefined || out.startsWith("-"))) {
      console.error("[nifra] --out needs a file path")
      process.exitCode = 1
      return
    }
    try {
      await runSnapshot(process.cwd(), out !== undefined ? { out } : {})
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    }
    return
  }
  if (command === "diff") {
    const { runDiff, DEFAULT_SNAPSHOT_FILE } = await import("./diff-tool.ts")
    const baseline = argv.slice(1).find((arg) => !arg.startsWith("-")) ?? DEFAULT_SNAPSHOT_FILE
    try {
      if (!(await runDiff(process.cwd(), baseline, { json: argv.includes("--json") }))) {
        process.exitCode = 1
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    }
    return
  }
  // Route assurance intentionally loads only its explicit config (which imports the backend it audits),
  // not the full SSR app. Like snapshot/diff, this works for API-only projects.
  if (command === "assure") {
    const { runAssurance } = await import("./assure.ts")
    const configIdx = argv.indexOf("--config")
    const config = configIdx !== -1 ? argv[configIdx + 1] : undefined
    if (configIdx !== -1 && (config === undefined || config.startsWith("-"))) {
      console.error("[nifra] --config needs a file path")
      process.exitCode = 1
      return
    }
    try {
      if (
        !(await runAssurance(process.cwd(), {
          json: argv.includes("--json"),
          ...(config !== undefined ? { config } : {}),
        }))
      )
        process.exitCode = 1
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    }
    return
  }
  if (command === "capabilities") {
    const action = argv[1]
    const valueAfter = (flag: string): string | undefined => {
      const index = argv.indexOf(flag)
      const value = index === -1 ? undefined : argv[index + 1]
      if (index !== -1 && (value === undefined || value.startsWith("-"))) {
        throw new Error(`[nifra] ${flag} needs a file path`)
      }
      return value
    }
    try {
      const { runCapabilityCheck, runCapabilitySnapshot } = await import("./capabilities-tool.ts")
      const config = valueAfter("--config")
      if (action === "snapshot") {
        const out = valueAfter("--out")
        if (
          !(await runCapabilitySnapshot(process.cwd(), {
            ...(config !== undefined ? { config } : {}),
            ...(out !== undefined ? { out } : {}),
          }))
        )
          process.exitCode = 1
      } else if (action === "check") {
        const lockfile = valueAfter("--lockfile")
        if (
          !(await runCapabilityCheck(process.cwd(), {
            ...(config !== undefined ? { config } : {}),
            ...(lockfile !== undefined ? { lockfile } : {}),
            json: argv.includes("--json"),
          }))
        )
          process.exitCode = 1
      } else {
        throw new Error("[nifra] capabilities needs `snapshot` or `check`")
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    }
    return
  }
  if (command === "manifest") {
    const action = argv[1]
    const valueAfter = (flag: string): string | undefined => {
      const index = argv.indexOf(flag)
      const value = index === -1 ? undefined : argv[index + 1]
      if (index !== -1 && (value === undefined || value.startsWith("-"))) {
        throw new Error(`[nifra] ${flag} needs a value`)
      }
      return value
    }
    try {
      const { runManifestDiff, runManifestEmit } = await import("./manifest-tool.ts")
      if (action === "emit") {
        const config = valueAfter("--config")
        const out = valueAfter("--out")
        const sign = valueAfter("--sign")
        if (
          !(await runManifestEmit(process.cwd(), {
            ...(config !== undefined ? { config } : {}),
            ...(out !== undefined ? { out } : {}),
            ...(sign !== undefined ? { sign } : {}),
          }))
        )
          process.exitCode = 1
      } else if (action === "diff") {
        const paths = argv.slice(2).filter((arg) => !arg.startsWith("-"))
        if (paths.length !== 2) throw new Error("[nifra] manifest diff needs <before> <after>")
        if (
          !(await runManifestDiff(process.cwd(), paths[0]!, paths[1]!, {
            json: argv.includes("--json"),
          }))
        )
          process.exitCode = 1
      } else {
        throw new Error("[nifra] manifest needs `emit` or `diff`")
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    }
    return
  }
  // `upgrade` is a pure cwd file-transformer (package.json pins + import moves) driven by a per-release
  // recipe, then verified with `nifra check`. Dispatch before the eager `loadApp` — it must run on any
  // repo (API-only, not built, or mid-upgrade with edits that don't yet typecheck under dry-run).
  if (command === "upgrade") {
    const { runUpgrade } = await import("./upgrade.ts")
    const version = argv.slice(1).find((arg) => !arg.startsWith("-"))
    try {
      const ok = await runUpgrade(process.cwd(), {
        ...(version !== undefined ? { version } : {}),
        write: argv.includes("--write"),
        json: argv.includes("--json"),
        list: argv.includes("--list"),
        verify: !argv.includes("--no-verify"),
      })
      if (!ok) process.exitCode = 1
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    }
    return
  }
  // `port` is a pure cwd-based portability linter (scans source, doesn't run the app) — like `check`/
  // `doctor`, dispatch before the eager `loadApp` so it runs on an API-only / not-yet-built project.
  if (command === "port") {
    const { runPort } = await import("./port.ts")
    const targetIdx = argv.indexOf("--target")
    const target = targetIdx !== -1 ? argv[targetIdx + 1] : undefined
    if (targetIdx !== -1 && (target === undefined || target.startsWith("-"))) {
      console.error("[nifra] --target needs a value: bun | node | deno | cf-pages | vercel")
      process.exitCode = 1
      return
    }
    try {
      const passed = await runPort(process.cwd(), {
        ...(target !== undefined ? { target } : {}),
        json: argv.includes("--json"),
        ci: argv.includes("--ci"),
        strict: argv.includes("--strict"),
      })
      if (!passed) process.exitCode = 1
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    }
    return
  }
  if (
    command !== "dev" &&
    command !== "build" &&
    command !== "start" &&
    command !== "context" &&
    command !== "routes"
  ) {
    console.error(`[nifra] unknown command: ${command}\n`)
    console.error(HELP)
    process.exitCode = 1
    return
  }
  const flags = parseFlags(argv.slice(1))
  const app = await loadApp(process.cwd(), flags.out)
  if (command === "dev") await dev(app, flags)
  else if (command === "build") {
    // `--target` (or `--report`) → the full per-target deploy build; otherwise the legacy client build.
    if (flags.target !== undefined || flags.report) {
      await buildForTarget(app, flags.target ?? "cf-pages", flags.report)
    } else await build(app)
  } else if (command === "context") console.log(describeProject(app))
  else if (command === "routes") {
    console.log(await describeRoutes(app, { json: argv.includes("--json") }))
  } else await start(app, flags)
}

// Only run the CLI when invoked as the entry (`bun cli.ts …`), not when a test imports it for the
// exported `parseFlags`. `import.meta.main` is true only for the process's entry module.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
