import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"
import { href } from "@nifrajs/web-react/router"

export const meta = docsMeta(
  "/docs/frontend-guidance",
  "Nifra - Frontend gotchas",
  "Version-scoped React, Preact, Solid, Vue, Svelte, and Nifra frontend gotchas exposed through the CLI and MCP.",
)

const COMMANDS = `# Browse all entries
nifra frontend

# Search a framework and symptom
nifra frontend solid "list reorder state"

# Give an agent stable JSON with versions and source links
nifra frontend vue "watcher never runs" --json

# The same catalog is available over MCP, as text plus structuredContent
nifra_frontend({ adapter: "react", symptom: "hydration mismatch" })`

export default function FrontendGuidance() {
  return (
    <div className="prose">
      <h1 className="page">Frontend gotchas</h1>
      <p className="lead">
        Nifra owns the server/client seam, while each frontend framework owns its own reactivity and
        lifecycle rules. The frontend catalog connects those two layers without pretending Nifra can
        replace the framework&apos;s compiler or linter.
      </p>

      <h2>Use the same catalog from every surface</h2>
      <p>
        <code>nifra frontend</code> is the human CLI and <code>nifra_frontend</code> is the MCP tool. Both
        select the same entries. Pass <code>--json</code> to the CLI, or read the MCP result&apos;s <code>structuredContent</code>,
        to receive a stable result with <code>schemaVersion</code>, an optional top-level <code>adapter</code>, match status,
        and <code>entries</code>. Entries include their <code>adapters</code> and may omit framework
        version ranges, categories, or source URLs.
      </p>
      <CodeBlock code={COMMANDS} lang="sh" />

      <h2>What Nifra reports</h2>
      <ul>
        <li>
          <strong>Shared seam cases:</strong> server-only imports, hydration determinism, typed loader
          data, duplicate runtimes, and stable list identity.
        </li>
        <li>
          <strong>React and Preact:</strong> effect dependencies and cleanup, hydration browser reads,
          state identity, compat boundaries, and runtime duplication.
        </li>
        <li>
          <strong>Solid:</strong> tracked reads, props and stores, <code>For</code> versus{" "}
          <code>Index</code>, and owner cleanup.
        </li>
        <li>
          <strong>Vue:</strong> refs in script, watch sources and traversal, reactive props, and SSR
          hydration.
        </li>
        <li>
          <strong>Svelte:</strong> runes, keyed each blocks, effect teardown, and browser-only SSR
          reads.
        </li>
        <li>
          <strong>CSP and browser:</strong> React <code>Activity</code> hydration, inline styles under a
          strict Content-Security-Policy, and WebKit&apos;s handling of streamed module scripts. Server-runtime differences are in{" "}
          <a href={href({ to: "/docs/runtime-differences" })}>runtime differences</a>.
        </li>
      </ul>

      <h2>Version-sensitive advice</h2>
      <p>
        Ecosystem entries may include the framework versions covered by the advice and link to the
        framework&apos;s documentation. When a major version changes the rule, add a new entry or update
        the version range with a fixture. Keep high-confidence, statically provable rules in{" "}
        <code>nifra check</code>; use this catalog for symptoms that need context or an ecosystem linter.
      </p>

      <h2>Contributing a gotcha</h2>
      <p>
        Add a broken and fixed fixture, a symptom users actually report, the exact cause, a safe fix,
        and an authoritative source. If the issue is Nifra&apos;s own boundary, add a check code and a
        regression test. If it belongs to React, Preact, Solid, Vue, or Svelte, link the ecosystem
        linter or compiler instead of duplicating its entire rule set.
      </p>
    </div>
  )
}
