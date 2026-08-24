#!/usr/bin/env bun
/**
 * `nifra` - the zero-config CLI for a nifra app. Reads `framework.ts` + `backend.ts` + `routes/` from
 * the project root (see {@link loadApp}) and wires the right `@nifrajs/web` entrypoint:
 *
 *   nifra dev      true-HMR dev server (Bun native HMR + nifra SSR)         - @nifrajs/web/dev
 *   nifra build    emit a complete target-specific deploy directory        - @nifrajs/web/build
 *   nifra start    run the default Bun build                               - dist/server.js
 *
 * Bun-only (it runs the framework's TS + Bun plugins directly). The *output* runs anywhere.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { inProcessClient } from "@nifrajs/client"
import {
  type CreateWebAppOptions,
  createWebApp,
  DEFAULT_DEV_PORT,
  type RenderAdapter,
} from "@nifrajs/web"
import { discoverRoutes } from "@nifrajs/web/fs"
import type { BunPlugin } from "bun"
import { bindCommandArgv, findCommandSpec, renderCommandCatalogHelp } from "./command-catalog.ts"
import { applyEnvFiles, takeEnvFileFlags } from "./env-file.ts"
import { type LoadedApp, loadApp, type NifraFramework } from "./load.ts"
import { chooseBuildPipeline, describePipeline } from "./pipeline-guard.ts"

export interface Flags {
  readonly port: number
  readonly out: string
  readonly poll: boolean
  /** `nifra build --target <t>`: emit a full deploy dir for this target. Defaults to `bun`. */
  readonly target: string
  /** `nifra build --report`: print a per-chunk size + gzip table after the build. */
  readonly report: boolean
  /** `nifra build --vite`: force the client + server through Vite/Rollup. Without a flag the pipeline is
   * chosen per app (`chooseBuildPipeline`) - Bun unless the app's only transforms are `vitePlugins`. */
  readonly vite: boolean
  /** `nifra dev --bun`: force the Bun-pipeline dev server. Rarely needed - `dev` and `build` share one
   * rule, so Bun is already the default unless `vitePlugins` are the app's ONLY transforms.
   *
   * `nifra build --bun`: force the Bun build. Refuses when that would drop the app's `vitePlugins`. */
  readonly bun: boolean
  /** `nifra dev --allow-duplicate-identity`: downgrade the Vite dev server's identity-parity check from
   * a hard failure to a loud warning so a duplicate coming from a linked sibling repo doesn't take dev
   * down while you fix the resolution. Dev only - `nifra build` always fails hard on a duplicate. */
  readonly allowDuplicateIdentity: boolean
}

/** Forward a re-exec'd Bun child's output without relying on Windows inheriting a pipe-of-a-pipe. */
async function forwardChildOutput(
  stream: ReadableStream<Uint8Array>,
  sink: { write(chunk: Uint8Array): unknown },
): Promise<void> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      await sink.write(value)
    }
  } finally {
    reader.releaseLock()
  }
}

const HELP = `nifra - zero-config dev/build/start for a nifra app

Usage:
  nifra dev     [--port <n>] [--poll]    Start the true-HMR dev server (Bun). Default port ${DEFAULT_DEV_PORT}.
                                         An app whose ONLY transforms are \`vitePlugins\` uses Vite (the
                                         Bun pipeline cannot run them); everything else uses Bun.
                [--vite]                 Force the Vite middleware/HMR pipeline.
                [--bun]                  Force Bun.serve native HMR (React Fast Refresh included, state
                                         preserved), no Vite in the process. CSS Modules, plain CSS,
                                         Tailwind and the app's own \`clientPlugins\`/\`serverPlugins\` run
                                         through the same Bun transforms production uses.
                [--allow-duplicate-identity]  Downgrade the Vite dev server's identity-parity check to a
                                         loud warning instead of a hard failure, so a duplicate React/
                                         adapter copy from a linked sibling repo doesn't take dev down
                                         while you fix the resolution. Dev only - \`nifra build\` still fails.
  nifra build   [--out <dir>] [--report]  Emit a complete deploy directory.
                [--target <t>]             Target a FULL deploy dir for <t>:
                                         bun | node | deno | cf-pages | vercel | static. Packages
                                         buildClient + buildServer (+ prerender for static) so an app
                                         no longer hand-writes build-<target>.ts + _worker.ts +
                                         _routes.json. The server entry is generated from your
                                         framework.ts (adapter) + backend.ts + routes/. --report prints
                                         a per-chunk size + gzip table (biggest first).
                [--vite | --bun]         Force the bundler. Without a flag it follows your config: Bun
                                         (faster, Bun-native) unless your ONLY transforms are
                                         \`vitePlugins\`, which the Bun build cannot run - then Vite,
                                         and it says so. --bun is refused in exactly that case rather
                                         than dropping the transforms silently.
  nifra start   [--port <n>] [--out <dir>]  Run the Bun build at <out>/server.js. Default port ${DEFAULT_DEV_PORT}.
  nifra context                          Print this project's route INDEX (API + page routes) + conventions
                                         for an AI agent's prompt. Per-route schemas: nifra mcp's
                                         nifra_context (path/kind slice) or nifra routes --json.
  nifra routes  [--json]                 List every route the app serves with its method(s): page
                                         routes (routes/) + the in-process backend's API routes,
                                         marking which API routes are auto-mounted under apiPrefix.
                                         --json for agents (see POST /api/x is/isn't served, not via 405).
  nifra routes  --graph [--json]         Render the public route surface as a Mermaid graph, or as
                                         stable JSON for contract explorers.
  nifra routes --modes [--target <t>]    Show each page route's RENDER MODE (static | isr | ssr),
                                         hydration, and cache policy in one table. With --target, gate
                                         against it: a route the target can't honour (an ssr route on a
                                         static build, ISR where there's no revalidation) exits nonzero
                                         with the consequence - run in CI so it fails the build, not prod.
  nifra init-agents [--force] [--json]   Retrofit an EXISTING app with the agent-discovery files a new
                                         app ships: .mcp.json + .cursor/mcp.json (register this project's
                                         nifra MCP), CLAUDE.md (MCP-first preamble + @AGENTS.md import),
                                         and a "## MCP server" section in AGENTS.md. No-clobber by
                                         default (skips a file you've customized); --force overwrites the
                                         owned files. AGENTS.md is only appended to, never overwritten.
  nifra mcp [dir]                        Start an MCP server (stdio) exposing this project to a coding
                                         agent. The project root is [dir] when given, else resolved from
                                         cwd (marker walk-up + the client's MCP roots); tools refuse
                                         with a fix when no nifra project is found - never a silent
                                         wrong-project answer. Tools: nifra_context, nifra_routes,
                                         nifra_run (backend), nifra_render (SSR a page), nifra_docs,
                                         nifra_example (verified snippets), nifra_scaffold (route→file),
                                         nifra_check (drift gate + fixes), nifra_levels (verification
                                         ladder), nifra_doctor (deps), nifra_explain (structured errors),
                                         nifra_inspect (request traces), nifra_learn (guided build path).
  nifra docs-mcp [--port <n>]            Serve the PUBLIC docs MCP over HTTP (nifra_docs + nifra_example) -
                                         self-host on a VPS so any remote agent can learn nifra. Default :8787.
  nifra learn   [<step>]                 Print the guided build-an-app path (the human view of nifra_learn):
                                         no arg for the step index, a number for one step's goal/do/verify.
  nifra check   [--json] [--lints-only]  Gate: typecheck + lints (hand-rolled fetch(), untyped client("…"),
                                         server-only imports in routes/). Run as "done"; --json for agents;
                                         --lints-only skips tsc for a near-instant inner-loop pass.
  nifra verify   [--release] [--json]    Run the shared repository verification gate. --release runs the
                                         full build, test, coverage, corpus, consumer, and cross-runtime gate.
  nifra fix     [--code <NF-code>]       Apply a registered diagnostic recipe, then print the remaining
                                         structured diagnostics.
  nifra sync-manifest                    Regenerate a committed web server-manifest.ts from routes/ WITHOUT
                                         a full build - clears server-manifest drift after a route add/rename
                                         (a new hydrating component still needs a full build).
  nifra sync-routes                      Regenerate nifra-routes.d.ts from routes/ so navigate({ to, search })
                                         is typed against each static route's searchSchema (a stale shape is a
                                         tsc error). Include the file in your tsconfig. Pure file write.
  nifra snapshot [--out <file>]          Write the backend's API contract (routes + schemas) as plain
                                         JSON - the baseline for \`nifra diff\`. Default api-snapshot.json.
  nifra diff    [<baseline>] [--json]    Breaking-change gate: re-snapshot the contract and compare
                                         against the committed baseline. Direction-aware (a new required
                                         request field or a removed response field breaks; widening a
                                         request enum or adding a response field doesn't) and fails
                                         closed. Exits non-zero on any breaking change - run it in CI.
  nifra sdk     --lang <python|go> [--out <file>]
                                         Generate a deterministic non-TypeScript SDK from backend.ts.
  nifra assure  [--config <file>] [--json]  Route-assurance report. Human table by default; --json emits
                                         the {ok, routes, findings} report for agents.
  nifra assure  --bundle [--json] [--strict] [--out <file>] [--hydration] [--interact]
                                         Emit one structured assurance {version, gates, verdict} bundle
                                         (always JSON). Records every applicable gate as pass, fail, or
                                         skip and exits non-zero unless its verdict is green. --strict,
                                         --hydration, --interact and --out imply --bundle.
  nifra contracts snapshot [--out <file>] Write the deterministic route contract lock.
  nifra contracts check [--json]          Check the current routes against contracts.lock.json.
  nifra replay <file>                     Replay a token-only verification metadata file.
  nifra capabilities snapshot [--out <file>] [--config <file>]
                                         Write the deterministic, token-only capability lockfile, but
                                         only after provenance + idempotency assurance passes.
  nifra capabilities check [--lockfile <file>] [--config <file>] [--json]
                                         CI gate: fail on raw effect-import bypasses, declaration/evidence
                                         drift, unsafe GET/HEAD writes, idempotency gaps, or lockfile drift.
  nifra capabilities explain <METHOD> <path> [--config <file>] [--json]
                                         Explain one route's declared capability tokens and static provenance.
  nifra manifest emit [--out <file>] [--config <file>] [--sign <key-ref>]
                                         Emit a deterministic route trust artifact after assurance passes;
                                         optionally write an Ed25519 signature via the configured KMS signer.
  nifra manifest diff <before> <after> [--json]
                                         Hash-verify and compare two manifests; fail on contract, assurance,
                                         capability, or response-classification regressions.
  nifra levels  [--json] [--min <n>] [--config <file>]
                                         Compute the verification ladder (L0 typed contract → L1 route
                                         assurance → L2 capability lockfile → L3 route manifest → L4
                                         invariant-tested); --min <n> fails the exit code below level n.
  nifra prove    [--json] [--file <path>] [--min <n>]
                                         Build the static verification work graph, plan the cheapest
                                         proofs for changed files, and report a machine-checkable stop
                                         condition. Requires a fresh build; never probes a running app.
  nifra doctor  [--json] [--auto-fix]    Flag undeclared imports and multiple physical copies of
                [--strict] [--target]     @nifrajs/core/React identity-sensitive dependencies;
                                         print production readiness, with --strict making absent
                                         applicable guarantees fail. --auto-fix writes safe local-
                                         version dependency fixes.
  nifra upgrade <version>                Run the per-release upgrade recipe for <version>: sweep every
                [--write] [--no-verify]  matching dependency pin (preserving ^/~/exact), move removed
                [--list] [--json]        packages, apply exact imports, then verify with nifra check.
                [--allow-downgrade]      Dry-run by default; --write applies then verifies (--no-verify
                                         to skip). --list shows available targets. Fail-closed on an
                                         unknown version or a rollback (--allow-downgrade overrides).
                                         Deterministic + idempotent.
  nifra port    [--target <t>] [--json]  Portability linter: print a feature × deploy-target capability
                [--ci] [--strict]        matrix (in-memory stores, in-process cron/WebSocket, Bun/Deno
                                         globals, node: builtins) with file:line evidence. --target auto-
                                         detected from build/deploy scripts, wrangler.toml, or vercel config;
                                         --ci (or any --target) exits nonzero when a used feature is
                                         unsupported on the target; --strict also fails on caveats.

Reads nifra.config.ts (adapter + clientModule + plugins; or framework.ts), backend.ts (optional), and
routes/ from the current directory. Run from your project root.

Port: \`dev\` and \`start\` share the default ${DEFAULT_DEV_PORT}. Override with \`--port <n>\` (alias \`-p\`) or the
\`PORT\` env var (\`--port\` wins over \`PORT\`, which wins over the default).

Env: \`--env-file <path>\` works on EVERY command and may be repeated (later files win). Commands that
reflect your app import it, so an app that validates its environment at module scope needs that
environment present - without it the app aborts before nifra runs a single check. A variable already
set in the process environment is never overwritten by a file.
  e.g. \`nifra check --env-file .env.local\`

${renderCommandCatalogHelp()}`

// Kept in lockstep with packages/cli/package.json by check:publish's version-consistency gate.
const CLI_VERSION = "3.1.0"

// A render adapter + nifra server are opaque to the CLI (it just forwards them); cast at the seam.
const asAdapter = (v: unknown): RenderAdapter => v as RenderAdapter
const asBunPlugins = (v: readonly unknown[]): BunPlugin[] => v as BunPlugin[]
const asUse = (v: (app: never) => void): NonNullable<CreateWebAppOptions["use"]> =>
  v as NonNullable<CreateWebAppOptions["use"]>
const apiOf = (backend: unknown): { api?: unknown } =>
  backend === undefined ? {} : { api: inProcessClient(backend as never) }

/**
 * Render an error for the CLI, unwrapping the detail a bare `.message` drops.
 *
 * `Bun.build` reports a bundling failure as an `AggregateError` whose `.message` is a generic
 * "Bundle failed" and whose `.errors` hold the real causes - the unresolved import, the plugin that
 * threw, each with a file and line. `buildClient`/`buildServer` catch a RETURNED `{ success: false }`
 * and print `result.logs`, but a `Bun.build` that THROWS (a plugin `onLoad`/`onResolve` that throws, a
 * resolution failure) rejects before that check runs, so the AggregateError reaches the CLI whole and a
 * catch printing only `.message` throws the causes away. That is the difference between "Bundle failed"
 * and "Could not resolve ./db from routes/x.tsx". So unwrap an AggregateError - directly, or one carried
 * as a `.cause` - into a line per underlying error.
 */
export function formatCliError(err: unknown): string {
  const aggregate =
    err instanceof AggregateError
      ? err
      : err instanceof Error && err.cause instanceof AggregateError
        ? err.cause
        : undefined
  if (aggregate !== undefined && aggregate.errors.length > 0) {
    const outer = err instanceof Error ? err.message : ""
    const head = outer !== "" && outer !== "Bundle failed" ? outer : "build failed"
    // `String(e)` (not `e.message`) so a Bun BuildMessage/ResolveMessage renders with its file + line,
    // not just the bare text. Multi-line entries are indented to stay under the head. Deduplicated
    // because Bun can repeat one cause across `.errors`.
    const details = [...new Set(aggregate.errors.map((e) => String(e).trim()))].map(
      (line) => `  - ${line.replace(/\n/g, "\n    ")}`,
    )
    return [head, ...details].join("\n")
  }
  if (err instanceof Error) return err.message
  return String(err)
}

async function dev(app: LoadedApp, flags: Flags): Promise<void> {
  if (flags.vite && flags.bun) {
    throw new Error("[nifra] `nifra dev` takes `--vite` or `--bun`, not both.")
  }
  // Default to Bun for the dev phase too. An app whose only transforms are Vite plugins stays on Vite so
  // its transform is never silently dropped; `--vite`/`--bun` make that choice explicit.
  // ONE rule for both phases - `chooseBuildPipeline` decides `dev` exactly as it decides `build`, so a
  // project cannot end up bundled by one toolchain in dev and the other in production. An earlier
  // version of this kept apps declaring `vitePlugins` on Vite for dev even when they also shipped Bun
  // equivalents, on the theory that the framework plugins were the safer HMR path. Measurement killed
  // it: Vue, Solid and Svelte all render correctly on the Bun pipeline, so the hedge bought nothing
  // and cost an app the guarantee that dev and production bundle the same way. (Svelte used to render
  // ONLY on Bun, which made the hedge actively harmful; it now renders on either - see the note at the
  // Vite branch for what the adapter had to be given to make that true.)
  const decision = chooseBuildPipeline(
    app.resolvedPlugins,
    flags.vite ? "vite" : flags.bun ? "bun" : undefined,
    "dev",
  )
  if (decision.pipeline === "bun") {
    // Bun's dev-server bundler takes plugins only via bunfig `[serve.static]`, read at process
    // start - so the boundary plugins (server-fn stubs, server-only emptying) are delivered by
    // generating a config and re-execing this same command once with `--config=`. The child proves
    // it IS the configured child with a per-launch random token (matched against the file the
    // parent just wrote, consumed on first read). A fixed sentinel here would be a secret-leak
    // switch: any inherited environment could set it, skip the generation, and serve the app with
    // no boundary plugins at all. An unprovable token acts as a parent - fail closed.
    const { consumeLaunchToken, writeBunDevConfig } = await import("./dev-bun-config.ts")
    if (!consumeLaunchToken(app.cwd, process.env.NIFRA_BUN_DEV_TOKEN)) {
      // Re-exec depth backstop: token verification makes recursion terminate (the direct child
      // always verifies), so hitting this means filesystem/env sabotage - refuse over fork-looping.
      const depth = Number(process.env.NIFRA_BUN_DEV_DEPTH ?? "0")
      if (depth >= 3) {
        throw new Error(
          "[nifra] `nifra dev --bun` could not verify its generated dev config after several " +
            "relaunches. Something is rewriting `.nifra/dev-bun/` or the environment between " +
            "launches; refusing to serve without the client-boundary plugins.",
        )
      }
      const { bunfigPath, launchToken } = await writeBunDevConfig(app.cwd, app.configPath)
      const child = Bun.spawn(
        [
          process.execPath,
          `--config=${bunfigPath}`,
          // The app's `conditions` reach SSR here or nowhere: bunfig has no key for them (a top-level,
          // `[run]`, `[serve.static]` or `[bundle]` `conditions` is parsed and ignored), and the re-exec
          // is the only point where this process's resolver is still configurable. Without it a package
          // with an `exports` map resolves to a DIFFERENT file on the server than in the client bundle,
          // which is the two-toolchains-one-module failure the pipeline guard exists to prevent.
          //
          // One flag per condition. `--conditions=a,b` is accepted and matches nothing: Bun takes the
          // whole string as a single condition name, so the comma form fails silently.
          ...(app.framework.conditions ?? []).map((condition) => `--conditions=${condition}`),
          // Reuse the actual loaded module rather than trusting either runtime's reconstructed
          // `argv[1]` spelling. This also works when a package-bin shim launches the CLI. The command
          // parser below already proves Bun.argv[2..] is the user argument vector (`dev`, flags, ...).
          fileURLToPath(import.meta.url),
          ...Bun.argv.slice(2),
        ],
        {
          // On Windows, inheriting the parent's already-piped stdout/stderr can make a nested Bun
          // process exit successfully without exposing either its banner or its error. Use explicit
          // pipes and forward them from this process instead; the caller still observes one CLI stream,
          // while the child gets real handles it can write to on every platform.
          stdin: "inherit",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            NIFRA_BUN_DEV_TOKEN: launchToken,
            NIFRA_BUN_DEV_DEPTH: String(depth + 1),
            // The child is the process that renders, so it is the one that needs dev-shaped runtimes.
            // A library ships its dev build behind the `development` export condition with a `NODE_ENV`
            // fallback for resolvers that set no conditions - which is Bun's runtime, where SSR runs,
            // so on the server that fallback is the only signal there is. It has to be in place before
            // the app's config is read, because reading it imports the adapter and through it the
            // framework runtime; setting it inside the dev server would already be a step too late.
            // Preserved if the caller pinned one.
            NODE_ENV: process.env.NODE_ENV ?? "development",
          },
        },
      )
      const forwarded = Promise.all([
        forwardChildOutput(child.stdout as ReadableStream<Uint8Array>, Bun.stdout),
        forwardChildOutput(child.stderr as ReadableStream<Uint8Array>, Bun.stderr),
      ])
      const forward = (): void => child.kill("SIGINT")
      process.on("SIGINT", forward)
      process.on("SIGTERM", forward)
      try {
        const [code] = await Promise.all([child.exited, forwarded])
        process.exitCode = code
      } finally {
        process.off("SIGINT", forward)
        process.off("SIGTERM", forward)
      }
      return
    }
    // SSR runs in THIS process, on Bun's runtime - a different loader from the dev-server bundler the
    // bunfig above configures. Both halves have to agree, so the runtime gets the same transforms:
    //
    //   - CSS Modules. The scoped name is a pure function of file path + class name, so the `"ssr"` form
    //     produces the identical map the client bundle emits (and no stylesheet - that ships from the
    //     client build). Without it `styles.box` is `undefined` on the server: the SSR markup carries no
    //     class, the page paints unstyled, and hydration then reports a className mismatch.
    //   - the app's `serverPlugins` - the SSR counterpart of the `clientPlugins` the generated bunfig
    //     delivers, exactly as `nifra build`'s prerender pass registers them.
    //
    // Registered BEFORE `createDevServer`, because a Bun runtime plugin only affects modules loaded
    // after it - and `createApp` imports the route modules.
    const { plugin } = await import("bun")
    const { cssModulesBunPlugin } = await import("@nifrajs/web/plugins/css-modules")
    plugin(cssModulesBunPlugin("ssr"))
    for (const p of asBunPlugins(app.resolvedPlugins.serverPlugins)) plugin(p)
    // "After" has one consequence an adapter has to respect. Reading the app's config is what PRODUCES
    // these plugins, so the config's import graph - which includes the adapter - is already loaded when
    // they register. An adapter must therefore not import an asset its own plugin compiles at module
    // scope; it has to defer to first render, which happens after this point. `@nifrajs/web-svelte`
    // loads its `Chain.svelte` that way for exactly this reason, and says so at the import.
    const { createDevServer } = await import("@nifrajs/web/dev")
    const { framework: fw, routesDir, outDir, backend } = app
    const server = await createDevServer({
      routesDir,
      outDir,
      clientModule: fw.clientModule,
      port: flags.port,
      // For the background client-leak guard, which re-runs `buildClient` on change - the SERVED client
      // bundle gets these same plugins through the generated bunfig, since Bun's dev-server bundler takes
      // plugins only as module paths. Never `vitePlugins`, which belong to the other pipeline;
      // `assertPipelineSeparation` already refuses a plugin sitting in the wrong slot.
      plugins: asBunPlugins(app.resolvedPlugins.clientPlugins),
      ...(fw.publicDir !== undefined ? { publicDir: fw.publicDir } : {}),
      ...(fw.conditions ? { conditions: fw.conditions } : {}),
      ...(fw.define ? { define: fw.define } : {}),
      createApp: (clientEntry, importQuery) =>
        createWebApp({
          adapter: asAdapter(fw.adapter),
          manifest: discoverRoutes(routesDir, { importQuery }),
          clientEntry,
          ...(fw.use ? { use: asUse(fw.use) } : {}),
          ...apiOf(backend),
        }),
    })
    console.log(`nifra dev (bun) → http://localhost:${server.port}`)
    console.log(`  ${describePipeline(decision)}`)
    return
  }
  // Preflight: the Vite fallback needs `vite` resolvable from the project. Run via `bunx @nifrajs/cli dev` the CLI
  // sits in an isolated install where the project's peer deps don't resolve, so the vite import below fails
  // with an opaque ERR_MODULE_NOT_FOUND. Surface the real fix instead.
  try {
    Bun.resolveSync("vite", app.cwd)
  } catch {
    throw new Error(
      "[nifra] `nifra dev` needs `vite` installed in this project. Run it via your workspace-local " +
        "script (`bun run dev`), not `bunx @nifrajs/cli dev` (which can't resolve the project's peers).",
    )
  }
  const { createViteDevServer } = await import("@nifrajs/web/vite")
  const { framework: fw, routesDir, cwd, backend } = app
  // No Bun SSR plugins here. `nifra dev` runs the VITE pipeline, and Vite now resolves and compiles
  // route modules for SSR too (via `ssrLoadModule`), so `.vue`/`.svelte`/Solid are handled by the
  // app's `vitePlugins` on both halves.
  //
  // Registering Bun's SFC plugins alongside was the structural intermix: two toolchains compiling the
  // same file in one process, with only one of them governed by Vite's `resolve.dedupe`. That is what
  // made an app's hand-written React alias fail to reach SSR, and it is the condition being removed -
  // not a redundancy worth keeping "just in case".
  //
  // Svelte is the case that proves the rule, and the discarded attempts are recorded so they are not
  // retried. The adapter package stays `ssr.external` (its context must be the ONE instance the
  // Bun-imported adapter provides), so BUN loads it - and `@nifrajs/web-svelte` renders through its own
  // `Chain.svelte`, which needs a compiler that this pipeline does not put in the runtime. Registering
  // the app's `serverPlugins` here, scoped to that package's directory, compiles it against a SECOND
  // Svelte runtime and the first `setContext` dies (`context.function` null); externalizing the
  // adapter's framework peer as well gets further and then dies on `context.function[FILENAME]`,
  // because `svelteBunPlugin` and `vite-plugin-svelte` do not emit the same dev-mode component shape.
  // Both attempts add a compiler. The fix removes one instead: `createViteDevServer` publishes its
  // `ssrLoadModule` via `setSsrModuleLoader`, and the adapter loads `Chain.svelte` AND `svelte/server`
  // through it - one toolchain, one runtime, context intact across the whole tree.
  const server = await createViteDevServer({
    root: cwd,
    routesDir,
    clientModule: fw.clientModule,
    plugins: app.resolvedPlugins.vitePlugins,
    ...(fw.publicDir !== undefined ? { publicDir: fw.publicDir } : {}),
    ...(fw.publicEnvPrefix !== undefined ? { publicEnvPrefix: fw.publicEnvPrefix } : {}),
    poll: flags.poll,
    port: flags.port,
    ...(flags.allowDuplicateIdentity ? { allowDuplicateIdentity: true } : {}),
    ...(fw.conditions ? { conditions: fw.conditions } : {}),
    ...(fw.define ? { define: fw.define } : {}),
    // `load` resolves route modules through VITE, not through Bun. That is what makes the Vite
    // pipeline own the whole phase: the client and the server now agree on every specifier, so
    // `resolve.dedupe` finally governs SSR and the dual-React crash cannot occur.
    createApp: (clientEntry, load) =>
      createWebApp({
        adapter: asAdapter(fw.adapter),
        manifest: discoverRoutes(routesDir, { load }),
        clientEntry,
        ...(fw.use ? { use: asUse(fw.use) } : {}),
        ...apiOf(backend),
      }),
  })
  console.log(`nifra dev (vite) → http://localhost:${server.port}`)
  console.log(`  ${describePipeline(decision)}`)
}

/**
 * `nifra build --target <t>` - package the engine (buildClient + buildServer + prerender) into one
 * command that emits a full deploy dir, so an app no longer hand-writes build-bun.ts + _worker.ts +
 * _routes.json per target. The adapter is imported from `framework.ts` (the edge-bundlable file - never
 * `nifra.config.ts`, which pulls in Vite plugins), and the backend from `backend.ts` when present;
 * `buildTarget` generates the per-target server entry from those + the app's `routes/`.
 */
/**
 * Refuse a `use` the generated server entry cannot import.
 *
 * `nifra build` emits `import { use } from <frameworkFile>` (framework.ts, the edge-bundlable file),
 * but `loadApp` prefers `nifra.config.ts` - so an app with BOTH files whose `use` lives only in
 * `nifra.config.ts` makes `fw.use` defined while `framework.ts` exports nothing of that name, and the
 * build dies later with an opaque bundler error pointing at generated code. Refuse it here with the
 * exact move instead, in the spirit of `assertPipelineSeparation` (load.ts).
 *
 * Detected by importing `frameworkFile` and checking the named export, not by comparing paths alone:
 * a split app legitimately DEFINES `use` in framework.ts and re-exports it from nifra.config.ts
 * (exactly how `adapter` reaches both readers), and a path compare would refuse that correct layout.
 * The import is cheap - framework.ts is already in the loaded config's module graph in that layout.
 */
export async function assertUseIsEdgeExported(
  use: NifraFramework["use"],
  configPath: string,
  frameworkFile: string,
): Promise<void> {
  if (use === undefined || configPath === frameworkFile) return
  const mod = (await import(frameworkFile).catch(() => ({}))) as { use?: unknown }
  if (typeof mod.use === "function") return
  throw new Error(
    `[nifra] \`use\` is exported from ${configPath} but not from ${frameworkFile}. ` +
      "`nifra build` generates a server entry that imports `use` from framework.ts (the edge-bundled " +
      "file), so this build would fail later with an opaque bundler error inside generated code.\n\n" +
      "  - Define `use` in framework.ts and re-export it from nifra.config.ts " +
      '(`export { use } from "./framework.ts"`) so `nifra dev` sees it too.',
  )
}

/**
 * A production build must not ship a workspace-linked package whose `default`-condition artifact is
 * missing or older than its source. The `"bun": "./src"` / `"default": "./dist"` split means Bun (this
 * build, the tests) reads live source while the deployed app and any node consumer read `dist/` - so a
 * green `nifra build` can bundle stale or absent dist and the drift never shows in a diff. The doctor
 * reports the same skew as an advisory during development; at build time it is a hard failure, because
 * this is the artifact that ships. No-op outside a workspace: tarball-installed deps cannot drift.
 */
async function assertFreshWorkspaceDists(cwd: string): Promise<void> {
  const pkgPath = resolve(cwd, "package.json")
  if (!existsSync(pkgPath)) return
  let rootPackage: Record<string, unknown>
  try {
    rootPackage = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>
    // @nifra-gate-reviewed: not a security gate. An unreadable/non-JSON package.json is a separate
    // build problem; returning here skips the freshness check rather than masking a denial.
  } catch {
    return // an unreadable/!JSON package.json is a separate problem; don't mask it as a stale-dist failure
  }
  const { collectStaleWorkspaceDists } = await import("./doctor.ts")
  const stale = await collectStaleWorkspaceDists(cwd, rootPackage)
  if (stale.length === 0) return
  const lines = stale.map((f) =>
    f.missing
      ? `  ${f.package}: ${f.distFile} was never built (source ${f.sourceFile})`
      : `  ${f.package}: ${f.distFile} is ${f.behindSeconds}s behind ${f.sourceFile}`,
  )
  throw new Error(
    `[nifra] build blocked: ${stale.length} workspace-linked package(s) ship a stale or missing dist artifact, so the deployed app would serve code this build did not produce:\n${lines.join(
      "\n",
    )}\nBuild the offending package(s) (\`bun run build\` in each) so every export target exists and is at least as new as its source, then rebuild.`,
  )
}

async function buildForTarget(app: LoadedApp, target: string, flags: Flags): Promise<void> {
  const { isBuildTarget, renderSizeReport, BUILD_TARGETS } = await import("@nifrajs/web/build")
  if (!isBuildTarget(target)) {
    throw new Error(`[nifra] unknown --target "${target}". Valid: ${BUILD_TARGETS.join(", ")}.`)
  }
  if (flags.vite && flags.bun) {
    throw new Error("[nifra] `nifra build` takes `--vite` or `--bun`, not both.")
  }
  // Which bundler builds this app. Default is Bun; an app whose ONLY transforms are `vitePlugins` gets
  // Vite instead, because the Bun build cannot run them and would silently omit the work. `--vite`/`--bun`
  // force it, and the one forced combination that would drop transforms throws.
  const decision = chooseBuildPipeline(
    app.resolvedPlugins,
    flags.vite ? "vite" : flags.bun ? "bun" : undefined,
  )
  const useVite = decision.pipeline === "vite"
  // Same deploy-dir output - buildTargetVite delegates to the same orchestrator as buildTarget - so only
  // the bundler and the plugin FORMAT (Vite plugins, not Bun) differ.
  const buildTarget = useVite
    ? (await import("@nifrajs/web/build-vite")).buildTargetVite
    : (await import("@nifrajs/web/build")).buildTarget
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
  await assertUseIsEdgeExported(fw.use, app.configPath, frameworkFile)
  // Plugin FORMAT differs by pipeline: the Bun build takes Bun plugins (clientPlugins/serverPlugins); the
  // Vite build takes the app's Vite plugins (fw.vitePlugins) for BOTH halves. buildTargetWith forwards
  // whatever it's given straight to the chosen bundler, which casts to its own plugin type.
  const plugins = useVite
    ? {
        clientPlugins: app.resolvedPlugins.vitePlugins as unknown as BunPlugin[],
        serverPlugins: app.resolvedPlugins.vitePlugins as unknown as BunPlugin[],
      }
    : {
        clientPlugins: asBunPlugins(app.resolvedPlugins.clientPlugins),
        serverPlugins: asBunPlugins(app.resolvedPlugins.serverPlugins),
      }
  const result = await buildTarget(target, {
    routesDir,
    outDir,
    workDir: resolve(cwd, ".nifra-build"),
    clientModule: fw.clientModule,
    adapterImport: frameworkFile,
    ...(fw.use ? { useImport: frameworkFile } : {}),
    ...(backend !== undefined && existsSync(backendFile) ? { backendImport: backendFile } : {}),
    ...plugins,
    ...(fw.conditions ? { conditions: fw.conditions } : {}),
    ...(fw.define ? { define: fw.define } : {}),
    ...(fw.publicDir !== undefined ? { publicDir: fw.publicDir } : {}),
    ...(fw.publicEnvPrefix !== undefined ? { publicEnvPrefix: fw.publicEnvPrefix } : {}),
    // The static target needs a built app to drive prerendering - only build it when targeting static.
    ...(target === "static" ? { prerenderApp: await buildPrerenderApp(app) } : {}),
  })
  // A production build must not certify itself green while a workspace-linked dependency ships a dist
  // artifact older than (or absent next to) its source: the `bun`->src condition let this compile read
  // live source, but the deployed app and every node consumer read `dist/`. Gate here, after the compile
  // proved the source is buildable, so the failure names the package to rebuild rather than a bundle error.
  await assertFreshWorkspaceDists(cwd)
  console.log(`nifra build (${target}, ${decision.pipeline}) → ${result.run}`)
  // The pipeline is stated on every build, not only the surprising ones - an auto-selected Vite build
  // must never look like the default, and a default Bun build must not leave the question open either.
  console.log(`  ${describePipeline(decision)}`)
  if (flags.report) console.log(`\n${renderSizeReport(result.size)}`)
}

/** Build the app FACTORY for the `static` target's prerender pass. Registers the
 * framework's SSR Bun plugins (so `.vue`/`.svelte`/Solid routes import) once, then return a factory that
 * `createWebApp`s the app for the client build's manifest. The client entry MUST be the real content-hashed
 * bundle (`client.entry`) - it's the hydration `<script src>` the prerendered HTML emits, so a placeholder
 * would 404 and the pages would render but never hydrate (inert controls). Styles/route-preload are wired
 * from the same manifest so the static HTML matches the deployed app. */
async function buildPrerenderApp(
  app: LoadedApp,
): Promise<(client: BuiltManifest) => { fetch(req: Request): Response | Promise<Response> }> {
  const { plugin } = await import("bun")
  const { framework: fw, routesDir, backend } = app
  for (const p of asBunPlugins(app.resolvedPlugins.serverPlugins)) plugin(p)
  return (client) =>
    createWebApp({
      adapter: asAdapter(fw.adapter),
      manifest: discoverRoutes(routesDir),
      clientEntry: client.entry,
      ...(fw.use ? { use: asUse(fw.use) } : {}),
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
  const serverFile = resolve(app.outDir, "server.js")
  if (!existsSync(serverFile)) {
    // A Cloudflare Pages build emits `_worker.js` (a Workers bundle), not a self-hosting `server.js` - so
    // `nifra start` on a dir built for cf-pages would otherwise fail with a bare "no server.js". Name the
    // actual mismatch and the fix.
    if (existsSync(resolve(app.outDir, "_worker.js"))) {
      throw new Error(
        `[nifra] ${app.outDir} holds a Cloudflare Pages worker bundle (_worker.js), not a self-hosting ` +
          "server. Run `nifra build --target bun` then `nifra start`, or serve this dir with `wrangler pages`.",
      )
    }
    throw new Error(
      `[nifra] no ${serverFile} - run \`nifra build\` or \`nifra build --target bun\` first.`,
    )
  }
  Bun.env.PORT = String(flags.port)
  await import(serverFile)
}

export function parseFlags(args: readonly string[]): Flags {
  // Port precedence: `--port`/`-p` (most specific) > `PORT` env > the framework default. The default is
  // the SAME uncommon port for `nifra dev` and `nifra start` (DEFAULT_DEV_PORT) so a project's URL is
  // stable across commands and doesn't collide with the usual 3000/5173/8080 crowd.
  let port = Number(Bun.env.PORT ?? DEFAULT_DEV_PORT)
  let out = "dist"
  let poll = Bun.env.CHOKIDAR_USEPOLLING === "1"
  let target = "bun"
  let report = false
  let vite = false
  let bun = false
  let allowDuplicateIdentity = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if ((a === "--port" || a === "-p") && args[i + 1]) port = Number(args[++i])
    else if (a === "--out" && args[i + 1]) out = args[++i] as string
    else if (a === "--poll") poll = true
    else if (a === "--target" && args[i + 1]) target = args[++i] as string
    else if (a === "--report") report = true
    else if (a === "--vite") vite = true
    else if (a === "--bun") bun = true
    else if (a === "--allow-duplicate-identity") allowDuplicateIdentity = true
  }
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`[nifra] invalid --port: ${port}`)
  }
  return { port, out, poll, target, report, vite, bun, allowDuplicateIdentity }
}

/**
 * `assure` uses the structured-bundle lane only when explicitly asked. A bare `--json` is NOT a
 * request for the bundle - it keeps the legacy `{ ok, routes, findings }` report machine-readable, so a
 * pre-bundle consumer is never silently handed the `{ gates, verdict }` shape. `--bundle` (or a
 * bundle-only flag) opts in; `--bundle --json` still yields the bundle, which is always JSON.
 */
export function assureBundleRequested(argv: readonly string[]): boolean {
  return (
    argv.includes("--bundle") ||
    argv.includes("--strict") ||
    argv.includes("--hydration") ||
    argv.includes("--interact") ||
    argv.includes("--out")
  )
}

/**
 * A command that reflects the project imports it, and an app that validates its environment at module
 * scope calls `process.exit` from inside that import. Nothing is throwable at that point, so the whole
 * output is the app's own abort message with no hint that a nifra command triggered it. Name the cause
 * on the way out and point at the flag that supplies the environment.
 */
function installReflectionExitHint(): (command: string | undefined) => void {
  let inFlight: string | undefined
  process.on("exit", (code) => {
    if (inFlight === undefined || code === 0) return
    process.stderr.write(
      `\n[nifra] \`nifra ${inFlight}\` reflects this project by importing it, and the import exited ` +
        `with code ${code} before the command produced a result - the message above came from your app, not nifra.\n` +
        `        If it is the app's environment validation, supply the environment and re-run:\n` +
        `        nifra ${inFlight} --env-file .env.local\n`,
    )
  })
  return (command) => {
    inFlight = command
  }
}

async function main(): Promise<void> {
  const { argv: rawArgv, files: envFiles } = takeEnvFileFlags(Bun.argv.slice(2))
  // Applied before any command runs: a reflecting command imports the app on its first await, and the
  // app reads its environment at module scope, so the variables must already be in place by then.
  if (envFiles.length > 0) await applyEnvFiles(process.cwd(), envFiles)
  const argv = rawArgv
  const command = argv[0]
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP)
    return
  }
  if (command === "--version" || command === "-v") {
    console.log(`nifra (@nifrajs/cli) ${CLI_VERSION}`)
    return
  }
  // `mcp` runs a long-lived stdio server and loads the project lazily per-tool - it must not go through
  // the eager `loadApp` below (which would fail fast on a project that's API-only / not yet built).
  if (command === "mcp") {
    const { runMcpServer } = await import("./mcp.ts")
    // `nifra mcp [dir]` - an explicit project directory pins the root (for clients configured outside
    // the project); otherwise the server resolves it from cwd + the client's MCP roots.
    const dirArg = argv[1] !== undefined && !argv[1].startsWith("-") ? argv[1] : undefined
    await runMcpServer(process.cwd(), CLI_VERSION, dirArg)
    return
  }
  // `docs-mcp` runs the PUBLIC docs MCP over HTTP - project-independent (serves the bundled corpus), so
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
  // `learn` prints the guided build-an-app path (the human head of `nifra_learn`). Project-independent:
  // the path is static, so no project needs to load. `nifra learn` for the index, `nifra learn 3` for a step.
  if (command === "learn") {
    const { renderLearnResult } = await import("./learn.ts")
    const stepArg = argv[1]
    console.log(
      renderLearnResult(
        stepArg !== undefined && /^\d+$/.test(stepArg) ? Number(stepArg) : undefined,
      ),
    )
    return
  }
  // `frontend` prints the client-side footgun catalog (the human head of `nifra_frontend`).
  // Project-independent and static. `nifra frontend` for the index, `nifra frontend vue "lost reactivity"`
  // to filter by adapter and/or symptom (either arg may be omitted; an adapter is recognized by name).
  if (command === "frontend") {
    const { renderFrontendResult, parseAdapter } = await import("./frontend-guidance.ts")
    const first = argv[1]
    const maybeAdapter = parseAdapter(first)
    const adapter = maybeAdapter === undefined ? undefined : first
    const symptom = (maybeAdapter === undefined ? argv.slice(1) : argv.slice(2))
      .filter((a) => !a.startsWith("-"))
      .join(" ")
    console.log(
      renderFrontendResult({
        adapter,
        symptom: symptom.length > 0 ? symptom : undefined,
      }),
    )
    return
  }
  const catalogSpec = command === undefined ? undefined : findCommandSpec(command)
  if (catalogSpec?.transports.includes("cli")) {
    const markReflecting = installReflectionExitHint()
    try {
      const input = bindCommandArgv(catalogSpec, argv.slice(1))
      markReflecting(command)
      const output = await catalogSpec.run(input, { cwd: process.cwd(), cliVersion: CLI_VERSION })
      markReflecting(undefined)
      const asRecord = output as unknown as Record<string, unknown>
      const wantsJson = asRecord.json === true || argv.includes("--json")
      if (wantsJson) {
        const value = catalogSpec.json?.(output, input) ?? output
        console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2))
      } else {
        console.log(catalogSpec.render(output, input).join("\n"))
      }
      if (catalogSpec.success !== undefined && !catalogSpec.success(output, input))
        process.exitCode = 1
    } catch (err) {
      // A thrown error is nifra's own reporting path, not a silent abort: clear the sentinel so the
      // hint stays reserved for the case where the process died inside the app import.
      markReflecting(undefined)
      console.error(formatCliError(err))
      process.exitCode = 1
    }
    return
  }
  if (command === "verify") {
    const { runReleaseVerification } = await import("./release-verification.ts")
    const ok = await runReleaseVerification(process.cwd(), {
      mode: argv.includes("--release") ? "release" : "default",
      json: argv.includes("--json"),
    })
    if (!ok) process.exitCode = 1
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
  if (command === "sdk") {
    const languageIndex = argv.indexOf("--lang")
    const language = languageIndex === -1 ? undefined : argv[languageIndex + 1]
    const outIndex = argv.indexOf("--out")
    const out = outIndex === -1 ? undefined : argv[outIndex + 1]
    if (language !== "python" && language !== "go") {
      console.error("[nifra] sdk needs --lang python or --lang go")
      process.exitCode = 1
      return
    }
    if (outIndex !== -1 && (out === undefined || out.startsWith("-"))) {
      console.error("[nifra] --out needs a file path")
      process.exitCode = 1
      return
    }
    try {
      const { runSdk } = await import("./sdk.ts")
      await runSdk(process.cwd(), { language, ...(out !== undefined ? { out } : {}) })
    } catch (err) {
      console.error(formatCliError(err))
      process.exitCode = 1
    }
    return
  }
  // `upgrade` is a pure cwd file-transformer (package.json pins + import moves) driven by a per-release
  // recipe, then verified with `nifra check`. Dispatch before the eager `loadApp` - it must run on any
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
        allowDowngrade: argv.includes("--allow-downgrade"),
      })
      if (!ok) process.exitCode = 1
    } catch (err) {
      console.error(formatCliError(err))
      process.exitCode = 1
    }
    return
  }
  // `port` is a pure cwd-based portability linter (scans source, doesn't run the app) - like `check`/
  // `doctor`, dispatch before the eager `loadApp` so it runs on an API-only / not-yet-built project.
  if (command !== "dev" && command !== "build" && command !== "start") {
    console.error(`[nifra] unknown command: ${command}\n`)
    console.error(HELP)
    process.exitCode = 1
    return
  }
  const flags = parseFlags(argv.slice(1))
  const app = await loadApp(process.cwd(), flags.out)
  if (command === "dev") await dev(app, flags)
  else if (command === "build") await buildForTarget(app, flags.target, flags)
  else await start(app, flags)
}

/**
 * Bun 1.4 on Windows can report `import.meta.main === false` for a module launched after a `--config`
 * re-exec, even though that module is the process entry. Treat the runtime flag as authoritative when
 * it is true, but recover from that false negative by comparing the runtime's entry path with this file.
 * The comparison is deliberately realpath-based so a package-bin symlink is accepted while an imported
 * copy of the CLI remains inert (tests import `parseFlags` from this module).
 */
function isMainModule(): boolean {
  if (import.meta.main) return true
  const target = fileURLToPath(import.meta.url)
  /**
   * Bun's `--config`/`--conditions` flags can sit before the script in the child argv. `argv[1]` is
   * therefore a runtime flag on Bun 1.4/Windows, not the entry module. `Bun.main` is the authoritative
   * runtime answer when available; the bounded argv fallback covers Bun releases that do not expose it.
   * Only non-flag entries are considered and every match must resolve to this exact file, so an
   * unresolved or arbitrary flag can never turn an imported CLI module into a running CLI.
   */
  const bunMain = (Bun as unknown as { main?: unknown }).main
  const argvEntries = (argv: readonly string[]): string[] => {
    const entries: string[] = []
    for (const value of argv.slice(1)) {
      if (value === "--") break
      if (value.startsWith("-")) continue
      entries.push(value)
      // The script is before the user's command/flags. A small bound keeps a caller's arbitrary
      // arguments from becoming an entry-point probe while covering a config plus a few conditions.
      if (entries.length === 4) break
    }
    return entries
  }
  const entries = [
    ...(typeof bunMain === "string" ? [bunMain] : []),
    ...argvEntries(Bun.argv),
    ...argvEntries(process.argv),
  ]
  const canonical = (value: string): Set<string> => {
    const paths = new Set<string>()
    const add = (path: string): void => {
      const slashed = path
        .replaceAll("\\", "/")
        .replace(/^\/\/\?\/UNC\//i, "//")
        .replace(/^\/\/\?\//, "")
      paths.add(process.platform === "win32" ? slashed.toLowerCase() : slashed)
    }
    try {
      add(resolve(value))
    } catch {
      return paths
    }
    for (const resolver of [realpathSync.native, realpathSync]) {
      try {
        add(resolver(value))
      } catch {
        // A virtual/synthetic argv entry has no realpath; it is not safe evidence of main-ness.
      }
    }
    return paths
  }
  const targetPaths = canonical(target)
  for (const entry of entries) {
    if (entry !== "" && [...canonical(entry)].some((path) => targetPaths.has(path))) return true
  }
  return false
}

// Only run the CLI when invoked as the entry (`bun cli.ts …`), not when a test imports it for the
// exported `parseFlags`.
if (isMainModule()) {
  main().catch((err) => {
    console.error(formatCliError(err))
    process.exitCode = 1
  })
}
