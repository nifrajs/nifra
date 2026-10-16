import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/cli",
  "Nifra - CLI",
  "Every Nifra CLI command: dev, build and start, the check and contract gates, code generation, the agent and dev-server tools, and upgrades.",
)

const COMMANDS = `nifra dev      # true-HMR dev server (Bun native HMR + Nifra SSR) - http://localhost:4321
nifra dev --vite   # the Vite middleware pipeline instead (automatic when vitePlugins are your ONLY transforms)
nifra build    # full Bun deploy → dist/server.js + content-hashed dist/assets/ (default target: bun)
nifra start    # run dist/server.js on Bun
nifra build --target cloudflare  # also: node | deno | vercel | static; add --report for chunk sizes

# dev + start share the default port 4321. Override per run: --port <n> (alias -p) or the PORT env var.
# flags: --port <n> (dev/start) · --out <dir> (build/start) · --target <t> (build) · --poll (dev)
#        --vite | --bun (dev/build) force the pipeline`

const UPGRADE = `nifra upgrade --list          # the release targets this CLI knows
nifra upgrade 5.0.0           # dry-run: every planned edit, nothing written
nifra upgrade 5.0.0 --write   # apply; it verifies with nifra check once the target is installed
bun install                   # install the new pins
nifra check                   # verify against them
nifra doctor                  # afterwards: no "mixed nifra versions" advisory left`

const FRAMEWORK = `// backend/framework.ts - deploy-safe; the generated server entry imports this file.
import { reactAdapter } from "@nifrajs/web-react"

export const adapter = reactAdapter
export const apiPrefix = "" // "" keeps backend/app.ts loader-only; "/api" also serves it over HTTP

// nifra.config.ts - CLI-only build/dev tooling; never imported by a deployed server.
// doc-check: skip - needs the third-party @vitejs/plugin-react; install it to run this.
import react from "@vitejs/plugin-react"
export { adapter } from "./backend/framework"
export const clientModule = "@nifrajs/web-react/client"
export const target = "bun"                   // what nifra build emits; nifra target <t> switches it
export const vitePlugins = [react()]          // only if you want Vite's dev pipeline
// Vue/Svelte/Solid also export:
//   clientPlugins = [vueBunPlugin("dom")]     // compile routes for the client build
//   serverPlugins = [vueBunPlugin("ssr")]     // compile routes into the target's server bundle
//   conditions    = ["solid"]                 // Solid: resolve solid-js to its source
//   define        = { __VUE_OPTIONS_API__: "true", ... }   // Vue feature flags`

const STYLEX_INSTALL = `# Install the runtime and the optional compiler peers.
bun add @stylexjs/stylex
bun add -d @babel/core @stylexjs/babel-plugin @babel/plugin-syntax-flow \\
  @babel/plugin-syntax-jsx @babel/plugin-syntax-typescript`

const STYLEX_CONFIG = `// nifra.config.ts - Bun's client and SSR build transforms.
import { stylexBunPlugin } from "@nifrajs/web/plugins/stylex"

export const clientPlugins = [stylexBunPlugin("dom")]
export const serverPlugins = [stylexBunPlugin("ssr")]`

const VITE_STYLEX = `// doc-check: skip - requires the third-party Vite React plugin
// If the app intentionally uses Vite, keep StyleX in vitePlugins.
import react from "@vitejs/plugin-react"
import { stylexVite } from "@nifrajs/web/plugins/stylex"

export const vitePlugins = [react(), stylexVite()]`

const STRUCTURE = `my-app/
  routes/            # the URL tree: index.tsx, _layout.tsx, [id].tsx, each with an optional x.backend.ts half
  backend/
    framework.ts     # the render adapter and server options - deploy-safe
    app.ts           # export const backend = server()...   (optional - the typed API)
  frontend/          # components and browser code
  shared/            # schemas, types and helpers both sides import
  nifra.config.ts    # CLI-only: client module, deploy target, dev/build plugins`

export default function Cli() {
  return (
    <div className="prose">
      <h1 className="page">CLI</h1>
      <p className="lead">
        <code>nifra</code> runs, builds, checks and upgrades an app from its project root. It reads{" "}
        <code>routes/</code>, <code>backend/framework.ts</code>, <code>backend/app.ts</code> and{" "}
        <code>nifra.config.ts</code> and wires the right <code>@nifrajs/web</code> entrypoint, so there
        is no <code>dev.ts</code>, <code>build.ts</code> or <code>server.ts</code> to write.{" "}
        <code>create-nifra</code> scaffolds the layout.
      </p>
      <CodeBlock code={COMMANDS} />

      <h2 id="conventions">The layout the CLI reads</h2>
      <p>
        <code>nifra dev</code> runs the Bun-native <a href="/docs/dev">HMR dev server</a>;{" "}
        <code>nifra build</code> runs the production build (content-hashed client assets plus a
        target-specific server); <code>nifra start</code> runs the default Bun output. The generated
        server serves assets and SSR with matched-route chunks preloaded and route CSS linked in each{" "}
        <code>&lt;head&gt;</code>.
      </p>
      <p>
        <strong>One rule picks the bundler, and it is the same rule in both phases</strong> - so a
        project can never be bundled by one toolchain in dev and the other in production. Bun runs
        everything, except an app whose <em>only</em> transforms are <code>vitePlugins</code>: the Bun
        pipeline cannot run those, so that app gets Vite for dev and build alike, and says so.{" "}
        <code>--vite</code> / <code>--bun</code> force the choice; <code>--bun</code> is refused on a
        Vite-only app rather than dropping its transforms silently. Every <code>dev</code> and{" "}
        <code>build</code> run prints which bundler it picked and why, and <code>nifra check</code>{" "}
        answers the same question without starting a server - see{" "}
        <a href="/docs/dev">which pipeline runs, when</a> for the full table.
      </p>
      <CodeBlock code={STRUCTURE} />
      <p>
        These paths are <strong>fixed</strong>: the CLI resolves them from the project root.{" "}
        <code>backend/app.ts</code> is optional; without it <code>nifra dev</code> and{" "}
        <code>nifra build</code> run the pages alone. A root <code>backend.ts</code> or{" "}
        <code>framework.ts</code>, the layout before 4.0, is refused with the command that moves it,
        and <code>nifra check</code> reports it as NF-C038: run{" "}
        <code>nifra migrate layout</code>. Only the entry file is pinned; the feature modules it{" "}
        <code>.merge()</code>s can live anywhere under <code>backend/</code>. Keep{" "}
        <code>backend/app.ts</code> a composition root - merging modules, registering no routes of
        its own - so each route&apos;s capability reach stays its own module&apos;s. What goes in each
        zone, and what the builds refuse to cross, is on{" "}
        <a href="/docs/structure">Project structure</a>.
      </p>

      <h2 id="framework">backend/framework.ts and nifra.config.ts</h2>
      <p>
        Keep the render <code>adapter</code> and the server options (<code>apiPrefix</code>,{" "}
        <code>mounts</code>, <code>csp</code>, <code>i18n</code>) in deploy-safe{" "}
        <code>backend/framework.ts</code>: the generated server entry imports it. Put{" "}
        <code>clientModule</code>, the deploy <code>target</code>, Vite plugins, compiler plugins,
        conditions, and defines in CLI-only <code>nifra.config.ts</code>, which re-exports the
        adapter. This keeps build tooling and native dependencies out of generated server bundles.
      </p>
      <CodeBlock code={FRAMEWORK} />

      <h2 id="commands">Command reference</h2>
      <p>
        Every command <code>nifra --help</code> lists, by what it is for. Most take{" "}
        <code>--json</code> for agents and CI. <code>--env-file &lt;path&gt;</code> works on every
        command and may repeat (a later file wins; a variable already set in the environment is never
        overwritten), which matters because commands that reflect your app import it. A dry run is
        the default wherever a command edits files.
      </p>
      <h3 id="run-and-build">Run and build</h3>
      <p>Develop, build a deploy directory, and run it.</p>
      <table className="cmd-table">
        <thead>
          <tr>
            <th>Command</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>nifra dev [--port &lt;n&gt;] [--vite | --bun] [--poll]</code>
            </td>
            <td>The dev server with true HMR, on port 4321. Bun runs it unless <code>vitePlugins</code> are the app&apos;s only transforms. <code>--no-indicator</code> hides the in-page issues badge.</td>
          </tr>
          <tr>
            <td>
              <code>nifra build [--target &lt;t&gt;] [--out &lt;dir&gt;] [--report]</code>
            </td>
            <td>A complete deploy directory for <code>bun</code>, <code>node</code>, <code>deno</code>, <code>cloudflare</code>, <code>vercel</code> or <code>static</code>. The server entry is generated from <code>backend/framework.ts</code>, <code>backend/app.ts</code> and <code>routes/</code>. <code>--report</code> prints each chunk&apos;s size.</td>
          </tr>
          <tr>
            <td>
              <code>nifra start [--port &lt;n&gt;] [--out &lt;dir&gt;]</code>
            </td>
            <td>Run the Bun build at <code>&lt;out&gt;/server.js</code>.</td>
          </tr>
          <tr>
            <td>
              <code>nifra target [&lt;target&gt;]</code>
            </td>
            <td>Show the deploy target kept in <code>nifra.config.ts</code>, or switch it. <code>nifra build</code> emits that target when no <code>--target</code> is given.</td>
          </tr>
        </tbody>
      </table>

      <h3 id="check-and-gate">Check and gate</h3>
      <p>The gates to run before calling a change done, locally and in CI.</p>
      <table className="cmd-table">
        <thead>
          <tr>
            <th>Command</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>nifra check [--lints-only] [--json] [--sarif]</code>
            </td>
            <td>Typecheck plus contract lints: a hand-rolled <code>fetch()</code> to your own API, an untyped client, backend code reached from browser code. <code>--lints-only</code> skips tsc; <code>--sarif</code> emits SARIF 2.1.0.</td>
          </tr>
          <tr>
            <td>
              <code>nifra review [--diff &lt;ref&gt;] [--strict] [--fix] [--write]</code>
            </td>
            <td>A deterministic, evidence-backed review of the project or a diff. <code>--fix</code> plans the recipes it can apply; <code>--fix --write</code> applies them.</td>
          </tr>
          <tr>
            <td>
              <code>nifra fix [--code &lt;NF-code&gt;]</code>
            </td>
            <td>Apply the registered recipe for a diagnostic, then print the diagnostics that remain.</td>
          </tr>
          <tr>
            <td>
              <code>nifra doctor [--strict] [--auto-fix] [--target &lt;t&gt;]</code>
            </td>
            <td>Find undeclared imports and duplicate copies of <code>@nifrajs/core</code>, React and other identity-sensitive packages, and print production readiness. <code>--auto-fix</code> writes the safe dependency fixes.</td>
          </tr>
          <tr>
            <td>
              <code>nifra port [--target &lt;t&gt;] [--ci] [--strict]</code>
            </td>
            <td>A feature-by-deploy-target matrix (in-memory stores, in-process cron and WebSockets, runtime globals, <code>node:</code> built-ins) with file:line evidence. <code>--ci</code> fails on a feature the target lacks.</td>
          </tr>
          <tr>
            <td>
              <code>nifra routes [--json] [--modes] [--hooks] [--graph]</code>
            </td>
            <td>Every page and API route with its methods. <code>--modes</code> shows each page&apos;s render mode and fails against <code>--target</code>; <code>--hooks</code> lists the hooks each route runs; <code>--graph</code> draws the routes as Mermaid.</td>
          </tr>
          <tr>
            <td>
              <code>nifra smoke [--fixture &lt;file&gt;] [--in-process]</code>
            </td>
            <td>The declared production smoke checks: SSR, the mounted API, 404s, headers, auth, contracts and hydration.</td>
          </tr>
          <tr>
            <td>
              <code>nifra cdn-check &lt;url&gt;</code>
            </td>
            <td>Check a deployed page behind a CDN: served from cache, no internal headers reaching visitors, and soft navigations getting page data rather than the cached document.</td>
          </tr>
          <tr>
            <td>
              <code>nifra i18n check [entry] [--strict]</code>
            </td>
            <td>Check i18n catalogs: coverage, missing and unused keys, ICU syntax, placeholder parity and plural cases. It imports the entry module.</td>
          </tr>
          <tr>
            <td>
              <code>nifra verify [--release]</code>
            </td>
            <td>Run the verification gate plan against the project&apos;s <code>package.json</code> scripts; a gate with no script is reported, not run. <code>--release</code> adds the build, test, coverage and cross-runtime gates.</td>
          </tr>
        </tbody>
      </table>

      <h3 id="contracts-and-assurance">Contracts and assurance</h3>
      <p>Lock the API contract, prove the security posture, and fail CI when either regresses. See Verification for the ladder these build.</p>
      <table className="cmd-table">
        <thead>
          <tr>
            <th>Command</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>nifra snapshot [--out &lt;file&gt;]</code>
            </td>
            <td>Write the backend&apos;s API contract (routes and schemas) as JSON, <code>api-snapshot.json</code> by default: the baseline for <code>nifra diff</code>.</td>
          </tr>
          <tr>
            <td>
              <code>nifra diff [&lt;baseline&gt;]</code>
            </td>
            <td>The breaking-change gate. A new required request field or a removed response field breaks; a new response field does not. Exits non-zero on a break.</td>
          </tr>
          <tr>
            <td>
              <code>nifra contracts snapshot | check</code>
            </td>
            <td>Write the deterministic route contract lock, <code>contracts.lock.json</code>, or check the current routes against it.</td>
          </tr>
          <tr>
            <td>
              <code>nifra assure [--config &lt;file&gt;]</code>
            </td>
            <td>Classify every route against <code>nifra.assurance.ts</code> and list the evidence each one is missing.</td>
          </tr>
          <tr>
            <td>
              <code>nifra assure --bundle [--strict] [--hydration] [--interact]</code>
            </td>
            <td>One JSON verdict over every applicable gate, each recorded as pass, fail or skip. Exits non-zero unless the verdict is green.</td>
          </tr>
          <tr>
            <td>
              <code>nifra levels [--min &lt;n&gt;]</code>
            </td>
            <td>The verification ladder: L0 typed contract, L1 route assurance, L2 capability lockfile, L3 route manifest, L4 invariant-tested. <code>--min</code> fails below a level.</td>
          </tr>
          <tr>
            <td>
              <code>nifra prove [--file &lt;path&gt;] [--min &lt;n&gt;]</code>
            </td>
            <td>Plan the cheapest proofs for the changed files and report a machine-checkable stop condition. Needs a fresh build.</td>
          </tr>
          <tr>
            <td>
              <code>nifra capabilities snapshot | check | explain</code>
            </td>
            <td>Write the capability lockfile once provenance and idempotency assurance pass; fail CI on an effect import that bypasses it, drift, a GET that writes, or an idempotency gap; explain one route&apos;s tokens with <code>explain &lt;METHOD&gt; &lt;path&gt;</code>.</td>
          </tr>
          <tr>
            <td>
              <code>nifra manifest emit | diff</code>
            </td>
            <td>Emit the hash-verified route trust manifest, signed with <code>--sign &lt;key-ref&gt;</code> through the configured KMS signer, or compare two manifests and fail on a regression.</td>
          </tr>
          <tr>
            <td>
              <code>nifra replay &lt;file&gt;</code>
            </td>
            <td>Validate a token-only verification metadata file and run it against its gate.</td>
          </tr>
        </tbody>
      </table>

      <h3 id="generate">Generate</h3>
      <p>Write the files the types and clients come from.</p>
      <table className="cmd-table">
        <thead>
          <tr>
            <th>Command</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>nifra types [--check]</code>
            </td>
            <td>Each route&apos;s <code>./+types</code> module under <code>.nifra/types</code>: params, schema-typed data, and <code>api</code> typed by <code>backend/app.ts</code>. <code>dev</code>, <code>build</code> and <code>check</code> refresh them too.</td>
          </tr>
          <tr>
            <td>
              <code>nifra schemas [--write] [--check]</code>
            </td>
            <td>Draft <code>loaderOutput</code> and <code>actionOutput</code> from each loader&apos;s and action&apos;s return type. <code>--write</code> adds the missing ones; it also lists returned fields a hand-written schema drops.</td>
          </tr>
          <tr>
            <td>
              <code>nifra sync-routes</code>
            </td>
            <td>Regenerate <code>nifra-routes.d.ts</code> so <code>navigate(&#123; to, search &#125;)</code> is typed by each route&apos;s search schema.</td>
          </tr>
          <tr>
            <td>
              <code>nifra sync-manifest</code>
            </td>
            <td>Regenerate a committed <code>server-manifest.ts</code> from <code>routes/</code> without a full build.</td>
          </tr>
          <tr>
            <td>
              <code>nifra openapi [--format json | yaml] [--path &lt;prefix&gt;]</code>
            </td>
            <td>The backend&apos;s OpenAPI document, including response types inferred at build time.</td>
          </tr>
          <tr>
            <td>
              <code>nifra sdk --lang python | go [--out &lt;file&gt;]</code>
            </td>
            <td>A deterministic Python or Go SDK generated from <code>backend/app.ts</code>.</td>
          </tr>
        </tbody>
      </table>

      <h3 id="agents-and-dev-server">Agents and the dev server</h3>
      <p>What a coding agent reads and runs. nifra mcp serves the same information as tools; see Coding agents.</p>
      <table className="cmd-table">
        <thead>
          <tr>
            <th>Command</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>nifra mcp [dir]</code>
            </td>
            <td>Start the project&apos;s MCP server over stdio: the route index, scaffolding, <code>nifra_check</code>, SSR rendering, the dev server&apos;s errors and logs, and the declared dev database.</td>
          </tr>
          <tr>
            <td>
              <code>nifra docs-mcp [--port &lt;n&gt;]</code>
            </td>
            <td>Serve the public docs MCP (<code>nifra_docs</code>, <code>nifra_example</code>) over HTTP, on port 8787 by default.</td>
          </tr>
          <tr>
            <td>
              <code>nifra context</code>
            </td>
            <td>Print the project&apos;s route index and conventions for an agent&apos;s prompt.</td>
          </tr>
          <tr>
            <td>
              <code>nifra learn [&lt;step&gt;]</code>
            </td>
            <td>Print the guided build-an-app path, or one step&apos;s goal, actions and check.</td>
          </tr>
          <tr>
            <td>
              <code>nifra init-agents [--force] [--sync-mcp]</code>
            </td>
            <td>Add the agent files a new app ships (<code>.mcp.json</code>, the <code>AGENTS.md</code> sections, each agent&apos;s pointer) to an existing app. <code>--sync-mcp</code> re-pins the MCP launch to the installed nifra.</td>
          </tr>
          <tr>
            <td>
              <code>nifra errors [--since &lt;n&gt;] [--category &lt;c&gt;]</code>
            </td>
            <td>What the running dev server caught (SSR, loader, API, build, browser and hydration errors), each a structured diagnostic. Exits 1 while errors are open.</td>
          </tr>
          <tr>
            <td>
              <code>nifra logs [--level &lt;l&gt;] [--grep &lt;s&gt;]</code>
            </td>
            <td>The dev server&apos;s console, server and browser, each line tagged with its request.</td>
          </tr>
          <tr>
            <td>
              <code>nifra explain [&lt;message&gt; | &lt;NF-code&gt;]</code>
            </td>
            <td>A structured diagnostic for an error, or what a check rule reports and how to fix it.</td>
          </tr>
          <tr>
            <td>
              <code>nifra db schema | query | role | audit</code>
            </td>
            <td>Read the development database declared as <code>devDatabase</code> in <code>nifra.config.ts</code>: its tables, one read-only <code>SELECT</code> (rows capped, secrets masked), the SQL for a read-only Postgres role, and a log of what ran.</td>
          </tr>
        </tbody>
      </table>

      <h3 id="migrate-and-upgrade">Migrate and upgrade</h3>
      <p>Move an app between layouts and releases. Each one is a dry run until --write.</p>
      <table className="cmd-table">
        <thead>
          <tr>
            <th>Command</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>nifra migrate layout [--write] [--zones]</code>
            </td>
            <td>Move an app onto the 4.0 layout: split each route into <code>x.tsx</code> and <code>x.backend.ts</code>, fold <code>_middleware.ts</code> into <code>_layout.backend.ts</code>, move <code>backend.ts</code> and <code>framework.ts</code> under <code>backend/</code>, and zone the other modules.</td>
          </tr>
          <tr>
            <td>
              <code>nifra migrate --from tailwind --to stylex</code>
            </td>
            <td>Move static Tailwind classes to StyleX; see below.</td>
          </tr>
          <tr>
            <td>
              <code>nifra upgrade &lt;version&gt; [--write] [--list]</code>
            </td>
            <td>Run every release recipe between the installed version and the target; see below.</td>
          </tr>
        </tbody>
      </table>

      <h2 id="tailwind-to-stylex">Tailwind to StyleX</h2>
      <p>
        Nifra includes a conservative codemod for moving static Tailwind classes to StyleX. It is a dry
        run by default, so inspect the proposed edits first:
      </p>
      <CodeBlock
        code={`nifra migrate --from tailwind --to stylex          # report safe edits and manual issues
nifra migrate --from tailwind --to stylex --write  # apply only safe edits
nifra migrate --from tailwind --to stylex --dir src`}
        lang="sh"
      />
      <p>
        Supported static <code>className</code> attributes become <code>stylex.props(...)</code> calls
        backed by a local <code>stylex.create(...)</code> table. Responsive breakpoints and
        element-local pseudo-classes such as <code>hover:</code> are supported. Dynamic class
        expressions, arbitrary values, parent-dependent variants, and unknown utilities stay unchanged
        and are reported with file/line evidence. A non-zero exit status means manual migration issues
        remain.
      </p>
      <p>
        StyleX compilation is native to Nifra&apos;s Bun pipeline. Install the runtime and compiler peers,
        then register both the browser and SSR transforms:
      </p>
      <CodeBlock code={STYLEX_INSTALL} lang="sh" />
      <CodeBlock code={STYLEX_CONFIG} />
      <p>
        If the project intentionally uses Vite, add the Vite adapter alongside its existing Vite
        transforms. Nifra will use Vite when <code>vitePlugins</code> are the app&apos;s only transforms:
      </p>
      <CodeBlock code={VITE_STYLEX} />

      <h2 id="upgrade">Upgrading nifra</h2>
      <p>
        Every <code>@nifrajs/*</code> package, <code>nifra</code> and <code>create-nifra</code> ship
        together at one version. Move a workspace between releases with{" "}
        <code>nifra upgrade &lt;version&gt;</code> rather than by editing pins: it runs every release
        recipe between the oldest version your <code>package.json</code> files pin and the target,
        oldest first. A recipe moves a removed package to its replacement, rewrites imports that
        moved, lists comments a release stopped honoring, and pins each group dependency to the
        target, keeping its <code>^</code> or <code>~</code> unless you pass <code>--exact</code>.
        The pins in <code>overrides</code>, <code>resolutions</code> and{" "}
        <code>pnpm.overrides</code> move with them, since an override decides what installs. A{" "}
        <code>peerDependencies</code> range is what a library accepts, not a pin: it is raised only
        when it excludes the target (keeping its operator, even with <code>--exact</code>), and a
        library&apos;s <code>&quot;&gt;=3.1.0&quot;</code> floor never sets the version the upgrade
        starts from unless nothing else, installed or declared, names one.
      </p>
      <CodeBlock code={UPGRADE} lang="bash" />
      <p>
        It is a dry-run until <code>--write</code>, and the same run twice makes no further edits. An
        unknown version or a target below what is installed is refused (<code>--allow-downgrade</code>{" "}
        when the rollback is intended); a target newer than the running CLI prints the command for
        that release&apos;s CLI. It edits files under the workspace root only: a symlinked package
        directory or <code>package.json</code> is never followed, and a group package installed by a
        link from outside the root is listed under &quot;Left alone&quot; for you to upgrade in its
        own repository. The MCP launch pin in <code>.mcp.json</code>, <code>.cursor/mcp.json</code>,{" "}
        <code>CLAUDE.md</code> and <code>AGENTS.md</code> moves to the target, or is dropped when
        the project declares <code>@nifrajs/cli</code> so the launch runs that install from then on:
        the edit <code>nifra init-agents --sync-mcp</code> makes. Another version pinned outside{" "}
        <code>package.json</code> is listed with its line: the rest of an agent file, an MCP config
        elsewhere, a Dockerfile or compose file, a CI workflow, and a lockfile other than the
        workspace&apos;s own (an image build&apos;s frozen lockfile, say), which you regenerate after
        installing. <code>nifra check</code> reads the installed packages, so <code>--write</code>{" "}
        runs it (<code>--no-verify</code> skips that) only once they match the target: until the new
        pins are installed it would judge the release you are leaving, and the command prints the
        install to run first instead. With <code>--write</code> it also saves the hook report from
        before the edits and, once the target is installed, prints how hook scope changed across the
        upgrade (<code>--no-hooks</code> skips that); before then,{" "}
        <code>nifra routes --hooks --since</code> compares after the install.{" "}
        <code>nifra doctor</code> and{" "}
        <code>nifra check</code> (NF-D002) point here when a workspace carries more than one version;
        see <a href="/docs/troubleshooting#mixed-versions">mixed nifra versions</a>. A{" "}
        <code>file:</code> package whose dependencies this upgrade moves keeps its old ones in{" "}
        <code>bun.lock</code>, where Bun never refreshes them; the plan lists each, and{" "}
        <code>--write</code> drops those entries so the next <code>bun install</code> records them
        again (see <a href="/docs/troubleshooting#stale-file-links">stale file: links</a>).
      </p>
      <p>
        A <code>link:</code> or <code>file:</code> dependency outside the root that installs its own{" "}
        <code>@nifrajs/*</code> at another version stops the upgrade before anything is written: its
        imports resolve from its own <code>node_modules</code>, so after the upgrade a{" "}
        <code>server()</code> it builds cannot be merged into yours. The refusal names each one with
        the commands that move it to the target; upgrade those first, or pass{" "}
        <code>--allow-linked-skew</code> to go ahead. <code>nifra upgrade --list</code> shows the
        targets with the notes of every release after the one you declare: what an app can observe
        changing on the way up.
      </p>

      <h2>Scope</h2>
      <p>
        <code>nifra build</code> defaults to a self-hosted Bun server. Use <code>--target node</code>,{" "}
        <code>deno</code>, <code>cloudflare</code>, <code>vercel</code>, or <code>static</code> for another
        complete deploy shape (see <a href="/docs/deployment">Deployment</a>). Run non-Bun outputs with
        the command printed by the build.
      </p>
    </div>
  )
}
