import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"
import { href } from "@nifrajs/web-react/router"

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
              <code>/</code> or <code>#</code> changes the routed path; Bun leaves the URL relative;{" "}
              <code>@nifrajs/node</code> answers 400.
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
              No Host: a relative URL on Bun, <code>http://localhost/…</code> through{" "}
              <code>@nifrajs/node</code>, <code>http://localhost:port/…</code> on Deno. Two Host lines:
              Bun uses the first, <code>@nifrajs/node</code> and Deno answer 400.
            </td>
            <td>
              <code>validateHost</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>pipelined-requests</code>
            </td>
            <td>
              Node runs every pipelined request&apos;s handler at once (30 of 30 in the probe); Bun and
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
        for Host validation on Bun, and about 3% for target normalization on Deno. Turn on target
        normalization when upstream guards and proxies apply a different path policy, or when your path
        guards run after Nifra normalizes the target. Turn on Host validation when the app builds URLs
        from the Host header.
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
              <code>application/json</code> on Node and Deno, and Nifra keeps each runtime&apos;s value.
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

      <h2>Frontend frameworks and browsers</h2>
      <p>
        The browser side has the same property: the behavior belongs to React or the
        browser, and Nifra only sits on top of it. Those entries live in the{" "}
        <a href={href({ to: "/docs/frontend-guidance" })}>frontend gotchas</a> catalog (<code>nifra frontend</code>),
        next to the per-framework reactivity cases:
      </p>
      <ul>
        <li>
          <code>react-activity-markers</code>: React 19.3.1 hangs hydrating an <code>&lt;Activity&gt;</code>{" "}
          whose boundary comments are missing from the server HTML.
        </li>
        <li>
          <code>csp-inline-style-attribute</code>: what a strict Content-Security-Policy does to inline{" "}
          <code>style</code> attributes, and the <code>&lt;slot&gt;</code> wrapper that avoids it.
        </li>
        <li>
          <code>webkit-streamed-modules</code>: WebKit runs module scripts of a streamed document only
          after the parser ends.
        </li>
      </ul>

      <h2>Keeping it true</h2>
      <p>
        A runtime release can change any entry. The catalog test checks the Bun claims for JSON parsing, JSON content type, recursion depth and
        URL errors against the Bun it runs on; the other entries are recorded observations. To add or fix an entry, reproduce it on
        each runtime, record the versions, and keep the cause to what the runtime does.
      </p>
    </div>
  )
}
