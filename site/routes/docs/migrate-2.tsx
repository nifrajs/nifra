import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra 2.0 migration guide — upgrade from 1.x",
  "Upgrade a Nifra 1.x application to 2.0: automated package and import moves, opt-in runtime plugins, client and web changes, external auth mounts, and release verification.",
)

const COMMANDS = [
  "nifra upgrade 2.0.0                 # dry-run: inspect every planned edit",
  "nifra upgrade 2.0.0 --write         # apply edits, then run nifra check",
  "bun install",
  "bun run test",
  "bun run build",
].join("\n")

const OPTIONAL_PLUGINS = [
  "// doc-check: skip — migration fragment uses the application's existing stores and handlers",
  "// 1.x",
  'import "@nifrajs/core/ws"',
  "const app = server({ idempotencyStore, effectLedger: { sink } })",
  '  .ws("/chat", socketHandler)',
  "",
  "// 2.0",
  'import { effectLedger } from "@nifrajs/core/effect-ledger"',
  'import { idempotency } from "@nifrajs/core/idempotency-plugin"',
  'import { mcp } from "@nifrajs/core/mcp"',
  'import { streaming } from "@nifrajs/core/sse"',
  'import { websocket } from "@nifrajs/core/ws"',
  "",
  "const app = server()",
  "  .use(idempotency({ store: idempotencyStore }))",
  "  .use(effectLedger({ sink }))",
  "  .use(mcp())       // only when the app declares tools/resources/prompts",
  "  .use(streaming()) // only when the app declares SSE routes",
  "  .use(websocket())",
  '  .ws("/chat", socketHandler)',
].join("\n")

const BUDGET = [
  "// doc-check: skip — before/after migration block includes the removed 1.x package",
  "// 1.x",
  'import { createRequestBudget } from "@nifrajs/budget"',
  "",
  "// 2.0",
  'import { createRequestBudget } from "@nifrajs/core/budget"',
].join("\n")

const WEB_MOUNT = [
  "// doc-check: skip — fragment uses the application adapter, manifest, and client entry",
  'import { inProcessClient } from "@nifrajs/client"',
  'import { createWebApp } from "@nifrajs/web"',
  'import { backend } from "./backend"',
  "",
  "const app = createWebApp({",
  "  adapter,",
  "  manifest,",
  "  clientEntry,",
  "  api: inProcessClient(backend),",
  "})",
].join("\n")

const EXTERNAL_MOUNTS = ["{", '  "externalMounts": ["/auth"]', "}"].join("\n")

const CLIENT_FAILURE = [
  "const result = await api.users({ id }).get()",
  "if (!result.ok) {",
  "  if (result.status === 404) {",
  "    result.data.message // typed from errors[404]",
  "  } else {",
  "    // Undeclared status or transport status 0: result.data is unknown.",
  "  }",
  "}",
].join("\n")

const REDIRECT = [
  "// 1.x",
  'redirect("/done", 307)',
  "",
  "// 2.0",
  'redirect("/done", { status: 307 })',
].join("\n")

export default function Migrate2() {
  return (
    <div className="prose">
      <h1 className="page">Upgrading from Nifra 1.x to 2.0</h1>
      <p className="lead">
        Nifra 2.0 removes the compatibility layer retained through 1.x and makes optional runtime
        systems explicit, instance-scoped plugins. The upgrade command handles deterministic package
        and import edits; this guide covers the structural changes it deliberately cannot guess.
      </p>

      <h2>1. Run the executable upgrade</h2>
      <CodeBlock code={COMMANDS} lang="sh" />
      <p>
        The command updates existing <code>@nifrajs/*</code>, <code>nifra</code>, and{" "}
        <code>create-nifra</code> dependency ranges to <code>2.0.0</code> while preserving
        caret/tilde/exact style. It also replaces the removed <code>@nifrajs/budget</code> dependency
        with <code>@nifrajs/core</code> and moves its imports to{" "}
        <code>@nifrajs/core/budget</code>. Dry-run is the default; <code>--write</code> applies and
        verifies with <code>nifra check</code>.
      </p>

      <h2>2. Install optional server systems explicitly</h2>
      <p>
        Idempotency, the effect ledger, MCP declarations, SSE, WebSockets, and Node-direct resolution
        are no longer enabled by server options, side-effect imports, or process-global state. Install
        only the systems an app uses with <code>.use()</code>; registration fails loudly if a required
        plugin is missing.
      </p>
      <CodeBlock code={OPTIONAL_PLUGINS} lang="ts" />
      <p>
        The <code>@nifrajs/node</code> adapter installs <code>nodeDirect()</code> automatically.
        Only applications calling <code>app.resolveNode()</code> directly need to install it.
      </p>

      <h2>3. Use the lean package entry points</h2>
      <p>
        The <code>@nifrajs/core</code> and <code>nifra</code> roots now expose the lean HTTP server
        surface. Prefer <code>@nifrajs/core/server</code> for <code>server()</code>, and import
        contracts, assurance, capabilities, budgets, manifests, reflection, SSE, WebSockets, and
        other optional systems from their documented subpaths.
      </p>
      <CodeBlock code={BUDGET} lang="ts" />
      <p>
        Contract-generated adversarial testing lives in <code>@nifrajs/testing</code>; the deprecated
        core invariant runner is removed.
      </p>

      <h2>4. Update full-stack backend mounts</h2>
      <p>
        <code>createWebApp</code> now auto-mounts a backend only through the platform-aware,
        symbol-keyed <code>BackendMount</code> interface. The old duck-typed{" "}
        <code>api.fetch(url, init)</code> convention is removed. Normal applications should pass the
        result of <code>inProcessClient(backend)</code> or <code>testClient(backend)</code>; both
        already implement the interface and forward <code>env</code> and <code>waitUntil</code>.
      </p>
      <CodeBlock code={WEB_MOUNT} lang="ts" />

      <h2>5. Declare external library mounts</h2>
      <p>
        Better Auth and similar libraries can own routes such as <code>/auth/**</code> outside the
        Nifra typed contract. A relative fetch to that library is intentional, but otherwise resembles
        a hand-rolled own-API call. Declare only the exact mounted prefix in{" "}
        <code>nifra.check.json</code> so <code>nifra check</code> does not keep CI red:
      </p>
      <CodeBlock code={EXTERNAL_MOUNTS} lang="json" />
      <p>
        Prefixes are segment-anchored: <code>/auth</code> covers <code>/auth</code> and its children,
        never <code>/authors</code>. Traversal paths are not suppressed. The normalized allowlist is
        echoed in human, JSON, and MCP check results, so every bypass remains auditable. This option
        affects only the typed-client lint; it does not mount, authorize, or trust the library.
      </p>

      <h2>6. Narrow typed-client failures by status</h2>
      <p>
        Routes with declared error schemas now return a failure union discriminated by HTTP status.
        After checking <code>!result.ok</code>, also narrow <code>result.status</code> before reading
        typed failure data. Undeclared statuses and transport status <code>0</code> remain unknown.
      </p>
      <CodeBlock code={CLIENT_FAILURE} lang="ts" />

      <h2>7. Apply the remaining web and protocol changes</h2>
      <ul>
        <li>
          Redirects accept an options object as their second argument.
          <CodeBlock code={REDIRECT} lang="ts" />
        </li>
        <li>
          Replace the removed prerender wrapper with <code>enumerateStaticRoutes()</code>.
        </li>
        <li>Fragment navigation resolves element IDs only.</li>
        <li>
          MCP Apps metadata uses only <code>_meta.ui.resourceUri</code>; remove the deprecated flat{" "}
          <code>ui/resourceUri</code> key.
        </li>
        <li>
          Telemetry integrations use <code>ObservationAdapter</code>; the{" "}
          <code>AgentSpan</code>, <code>AgentSpanExporter</code>, and <code>SpanExporter</code> aliases
          are removed.
        </li>
        <li>Invalid HTTP method overrides always fail closed with 400.</li>
        <li>
          <code>nifra build</code> always emits a complete deploy directory and defaults to Bun;{" "}
          <code>nifra start</code> runs the generated <code>server.js</code>.
        </li>
      </ul>

      <h2>8. Run the release gates</h2>
      <ol>
        <li>
          Run <code>nifra check --json</code> and fix every error.
        </li>
        <li>
          If the project has <code>nifra.assurance.ts</code>, run <code>nifra assure --json</code>.
        </li>
        <li>
          If capabilities are configured, review a new snapshot and run{" "}
          <code>nifra capabilities check --json</code>.
        </li>
        <li>Run the application test suite and a production build.</li>
        <li>
          Exercise authentication, redirects, backend mounting, SSE/WebSocket routes, and each deploy
          adapter the application uses.
        </li>
      </ol>
    </div>
  )
}
