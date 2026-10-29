import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/runtime-differences",
  "Nifra - Runtime differences",
  "Where Bun, Node, Deno and Cloudflare Workers behave differently under the same Nifra app, with the fix and the Nifra option that decides it, exposed through the CLI and MCP.",
)

const COMMANDS = `# Browse every difference
nifra runtime

# Filter by runtime, and search by what you observe
nifra runtime deno "path guard skipped"

# Stable JSON for an agent, with versions and categories
nifra runtime node "pipelined requests" --json

# The same catalog over MCP, as text plus structuredContent
nifra_runtime({ runtime: "bun", symptom: "env var undefined" })`

const OPTIONS = `import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"

// Deno (and Bun's Host handling): the Host header and the request target are checked and resolved.
const app = server({ validateHost: true, normalizeTarget: true })

// Node: the adapter has the same normalizeTarget switch.
await serve(app, { port: 3000, normalizeTarget: true })`

export default function RuntimeDifferences() {
  return (
    <div className="prose">
      <h1 className="page">Runtime differences</h1>
      <p className="lead">
        Nifra runs the same <code>app.fetch(Request): Response</code> on Bun, Node, Deno and Cloudflare
        Workers. The runtimes underneath do not behave identically, and none of the differences below
        is Nifra&apos;s doing: they come from the runtimes and their engines. Where Nifra has a switch
        that decides which behavior an app gets, the entry names it.
      </p>

      <h2>Use the same catalog from every surface</h2>
      <p>
        <code>nifra runtime</code> is the human CLI and <code>nifra_runtime</code> is the MCP tool. Both
        read one catalog. Each entry records what you observe, what each runtime does, the fix, how to
        verify it on your own runtime, and the versions it was measured on (Bun 1.4.4, Node 26.12 and
        Deno 2.9.8 unless it says otherwise).
      </p>
      <CodeBlock code={COMMANDS} lang="sh" />

      <h2>Requests</h2>
      <table>
        <thead>
          <tr>
            <th>entry</th>
            <th>what differs</th>
            <th>Nifra switch</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>dot-segment-targets</code>
            </td>
            <td>
              Bun and Workers hand over a resolved URL, so <code>/public/../admin</code> arrives as{" "}
              <code>/admin</code>; Deno and Node hand over the target as sent.
            </td>
            <td>
              <code>normalizeTarget</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>host-builds-url</code>
            </td>
            <td>
              Deno builds <code>Request.url</code> from the Host it received, so a Host holding{" "}
              <code>/</code> or <code>#</code> changes the routed path; Bun leaves the URL relative.
            </td>
            <td>
              <code>validateHost</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>missing-or-repeated-host</code>
            </td>
            <td>
              No Host: relative URL on Bun, <code>http://localhost:port/…</code> on Deno. Two Host lines:
              Bun joins them, Deno answers 400, Node keeps the first.
            </td>
            <td>
              <code>validateHost</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>get-request-body</code>
            </td>
            <td>
              A GET that carries a body reads as empty on Bun and Deno; Node&apos;s <code>http</code>{" "}
              exposes the bytes.
            </td>
            <td>none: do not read a GET body</td>
          </tr>
          <tr>
            <td>
              <code>pipelined-requests</code>
            </td>
            <td>
              Node runs every pipelined request&apos;s handler at once (50 of 50 in the probe); Bun and
              Deno run one per connection.
            </td>
            <td>
              <code>requestTimeoutMs</code>, proxy limits
            </td>
          </tr>
        </tbody>
      </table>
      <CodeBlock code={OPTIONS} lang="ts" />
      <p>
        Both switches are off by default because checking costs throughput: about 6% of a bare route
        for Host validation on Bun, and about 3% for target normalization on Deno. Turn them on when path
        guards, or a proxy that normalizes paths, sit in front of or inside the app.
      </p>

      <h2>Responses and the language</h2>
      <table>
        <thead>
          <tr>
            <th>entry</th>
            <th>what differs</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>json-content-type</code>
            </td>
            <td>
              <code>Response.json</code> sends <code>application/json;charset=utf-8</code> on Bun and{" "}
              <code>application/json</code> on Node and Deno.
            </td>
          </tr>
          <tr>
            <td>
              <code>engine-error-messages</code>
            </td>
            <td>
              Bun is JavaScriptCore; Node and Deno are V8. <code>JSON.parse</code>, <code>new URL</code>{" "}
              and null reads word their errors differently, so match on the class or a code.
            </td>
          </tr>
          <tr>
            <td>
              <code>deep-recursion</code>
            </td>
            <td>
              Bun runs <code>return f()</code> as a tail call (200,000 deep returned); Node and Deno
              overflow between 9,000 and 20,000 frames.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Process, files and the edge</h2>
      <table>
        <thead>
          <tr>
            <th>entry</th>
            <th>what differs</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>dotenv-autoload</code>
            </td>
            <td>
              Bun loads <code>.env</code> at startup; Node and Deno need <code>--env-file</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>spawn-env</code>
            </td>
            <td>
              <code>Bun.spawn</code> without <code>env</code> ignores <code>process.env</code> changes made
              after startup.
            </td>
          </tr>
          <tr>
            <td>
              <code>glob-symlinks</code>
            </td>
            <td>
              <code>Bun.Glob</code> skips symlinks unless <code>followSymlinks: true</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>workerd-node-builtins</code>
            </td>
            <td>
              Which <code>node:</code> builtins a Worker gets without <code>nodejs_compat</code> depends on
              its <code>compatibility_date</code>.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Frontend frameworks and bundlers</h2>
      <p>
        The browser and bundler side has the same property: the behavior belongs to React, Vite or the
        browser, and Nifra only sits on top of it. Those entries live in the{" "}
        <a href="/docs/frontend-guidance">frontend gotchas</a> catalog (<code>nifra frontend</code>),
        next to the per-framework reactivity cases:
      </p>
      <ul>
        <li>
          <code>react-activity-markers</code>: React 19.3.1 hangs hydrating an <code>&lt;Activity&gt;</code>{" "}
          whose boundary comments are missing from the server HTML.
        </li>
        <li>
          <code>vite-resolveid-order</code> and <code>vite-resolve-custom-dropped</code>: Vite 8 plugin
          hook ordering, and a <code>this.resolve</code> option that rolldown drops in some builds.
        </li>
        <li>
          <code>vite-dev-csp-nonce</code> and <code>csp-inline-style-attribute</code>: what a strict
          Content-Security-Policy blocks in Vite dev and in inline <code>style</code> attributes.
        </li>
        <li>
          <code>webkit-streamed-modules</code>: WebKit runs module scripts of a streamed document only
          after the parser ends.
        </li>
      </ul>

      <h2>Keeping it true</h2>
      <p>
        A runtime release can change any entry. The catalog test runs the Bun claims against the Bun it
        runs on, so a drift fails a build instead of going stale. To add or fix an entry, reproduce it on
        each runtime, record the versions, and keep the cause to what the runtime does.
      </p>
    </div>
  )
}
