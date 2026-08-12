import { CodeBlock } from "../../highlight"
import { docsMeta } from "../../meta"

export const hydrate = false

export const meta = docsMeta(
  "/docs/agents",
  "Nifra - Coding agents",
  "An MCP server that lets an agent build a Nifra app and then prove it: verified docs and examples, a drift gate to fix against, real requests to check behaviour, and a ladder that says what the project actually holds.",
)

const SETUP = `# Registers the MCP server and writes the agent files. Never clobbers what is already there.
nifra init-agents

#   .mcp.json          the server, for Claude Code and anything else reading that format
#   .cursor/mcp.json   the same, for Cursor
#   CLAUDE.md          project conventions an agent reads on entry
#   AGENTS.md          the same, in the vendor-neutral format

# Then restart the agent so it picks the server up.`

const LOOP = `# 1. What is here?
nifra_context           # routes, page routes, conventions - one call, unfiltered, as an index
nifra_routes            # API routes as JSON: { method, path, call, body?, query?, response? }

# 2. What is the real API?
nifra_docs   {query}    # searches the docs; returns only matching sections
nifra_example{task}     # a snippet that is typechecked against the live API
nifra_types  {name}     # the exact declaration, parsed from the built .d.ts

# 3. Write the code, then close the loop.
nifra_check             # typecheck + lints, each with a structured fix
nifra_fix               # applies the mechanical ones
nifra_run    {request}  # a real request through the backend: status, headers, parsed body
nifra_render {path}     # SSR a page route, returns the HTML
nifra_test              # bun test, bounded structured results

# 4. What does it now prove?
nifra_assure            # every route's required evidence, and what is missing
nifra_levels            # { achieved, levels[] } - the ladder`

const PROMPT = `// doc-check: skip - the completion callback is yours; any provider SDK fits the shape.
import { prompt } from "@nifrajs/prompt"
import { t } from "@nifrajs/schema"

const extract = prompt("Extract the contact from the text.")
  .input(t.object({ text: t.string() }))
  .output(t.object({ name: t.string(), email: t.string({ format: "email" }) }))

// The result is PARSED against the output schema, so a malformed completion throws here
// rather than becoming a wrong value three layers away.
const contact = await extract.run({ text }, { complete })`

const TELEMETRY = `import { server } from "@nifrajs/core/server"
import { agentTelemetry, consoleAgentExporter } from "@nifrajs/agent-telemetry"

export const app = server().use(agentTelemetry({ exporter: consoleAgentExporter() }))`

const GATE = `# The two an agent should gate on. Both exit non-zero on failure, so they work in CI unchanged.
nifra check
nifra levels --min 1`

const OUTPUT = `{
  "ok": true,
  "typecheck": "pass",
  "diagnostics": []
}`

const HOSTED = `# Claude Code
claude mcp add --transport http nifra-docs https://mcp.nifra.dev

# Claude.ai (web or desktop): Settings -> Connectors -> Add custom connector -> https://mcp.nifra.dev
# ChatGPT (developer mode):   Settings -> Connectors -> add the same URL

# Cursor - .cursor/mcp.json
# { "mcpServers": { "nifra-docs": { "url": "https://mcp.nifra.dev" } } }

# VS Code - .vscode/mcp.json
# { "servers": { "nifra-docs": { "type": "http", "url": "https://mcp.nifra.dev" } } }`

export default function Agents() {
  return (
    <div className="prose">
      <h1 className="page">Coding agents</h1>
      <p className="lead">
        Nifra ships an MCP server. It is not a documentation lookup bolted onto a framework: an agent
        can read the project, learn the real API, run actual requests against the backend it just
        edited, and finish with a report of what the change proved.
      </p>

      <h2>One MCP, two ways to connect</h2>
      <p>
        There is one Nifra MCP. It reaches your agent over the two standard MCP transports, and which
        one you use is decided by a single question: <b>is the agent working inside a Nifra repo?</b>
      </p>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>
              Local - <code>nifra mcp</code>
            </th>
            <th>
              Hosted - <code>mcp.nifra.dev</code>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Transport</td>
            <td>stdio - the agent spawns it as a process</td>
            <td>HTTP - add one URL, nothing to install</td>
          </tr>
          <tr>
            <td>Runs</td>
            <td>on your machine, in your project</td>
            <td>on our infrastructure</td>
          </tr>
          <tr>
            <td>Sees</td>
            <td>your routes, schemas, and files - locally only, nothing leaves the machine</td>
            <td>only Nifra's published docs corpus - never your code</td>
          </tr>
          <tr>
            <td>Tools</td>
            <td>
              everything: project tools (<code>nifra_context</code>, <code>nifra_run</code>,{" "}
              <code>nifra_assure</code>, …) <b>plus</b> the docs tools
            </td>
            <td>
              docs tools only (<code>nifra_docs</code>, <code>nifra_example</code>,{" "}
              <code>nifra_types</code>, <code>nifra_learn</code>)
            </td>
          </tr>
          <tr>
            <td>Use when</td>
            <td>building or editing a Nifra app</td>
            <td>learning Nifra, or the client can't spawn processes (Claude.ai, ChatGPT)</td>
          </tr>
        </tbody>
      </table>
      <p>
        The project tools <em>must</em> run where your code is - hosting them would mean uploading
        your source, which is exactly what this design refuses to do. And the local server does not
        proxy the hosted one for docs: the docs corpus ships inside the npm package, so the answers
        match <b>the Nifra version installed in your project</b>, work offline, and send nothing
        anywhere. This hosted-plus-local pairing is the same shape Supabase, Stripe, Sentry, and
        GitHub ship their MCP servers in, for the same reason: public knowledge can be hosted; tools
        that touch your own code and data run where that code lives.
      </p>
      <p>
        So: inside a Nifra repo, register the local server (it includes the docs tools - you never
        need both). Anywhere else, add the URL.
      </p>

      <h2>Setup</h2>
      <CodeBlock code={SETUP} lang="bash" />
      <p>
        The generated files are additive and the command will not overwrite an existing one, so it is
        safe to re-run after a Nifra upgrade.
      </p>

      <h2>The loop</h2>
      <CodeBlock code={LOOP} lang="bash" />

      <h2>Why the answers can be trusted</h2>
      <p>
        The three corpora an agent learns from are generated from the built packages, not written by
        hand. <code>nifra_types</code> is parsed out of each package's <code>.d.ts</code>, so a
        signature it returns is the signature that shipped. <code>nifra_example</code> serves only
        snippets that the docs gate compiles against the live API, so it cannot hand back a call that
        no longer exists. Both are regenerated and verified in CI, which is what makes them worth more
        to an agent than its own memory of the framework.
      </p>
      <p>
        <code>nifra_types</code> also follows each package's <code>exports</code> map rather than
        scanning the build output, so it will not offer a type that is real but unimportable.
      </p>

      <h2>From any assistant, hosted</h2>
      <p>
        The teaching tools - <code>nifra_docs</code>, <code>nifra_example</code>,{" "}
        <code>nifra_types</code>, <code>nifra_learn</code> - are also served, project-independent, at{" "}
        <code>mcp.nifra.dev</code>. Add that one URL to any assistant and it learns Nifra from the same
        verified corpora, with no local checkout. It is read-only and needs no key. The project tools
        above still come from <code>nifra mcp</code> in your own repo, where they can see your routes.
      </p>
      <CodeBlock code={HOSTED} lang="bash" />
      <p>
        Cursor reads it in one click:{" "}
        <a href="cursor://anysphere.cursor-deeplink/mcp/install?name=nifra-docs&config=eyJ1cmwiOiJodHRwczovL21jcC5uaWZyYS5kZXYifQ==">
          add Nifra docs to Cursor
        </a>
        .
      </p>

      <h2>The gate to write against</h2>
      <p>
        <code>nifra_check</code> is the one an agent should loop on. It returns structured
        diagnostics, each carrying its own fix, so a failure is a work item rather than a wall.
      </p>
      <CodeBlock code={OUTPUT} lang="json" />
      <p>
        It catches the drift that types alone miss: a hand-rolled <code>fetch()</code> to your own API
        instead of the typed client, a <code>client(...)</code> missing its type argument, a
        server-only import reaching a route module, a route manifest that no longer matches{" "}
        <code>routes/</code>.
      </p>

      <h2>Knowing when to stop</h2>
      <p>
        Passing tests say the code does what its tests say. <code>nifra_levels</code> answers the
        different question of what the project <em>holds</em>, as a cumulative ladder from a typed
        contract (L0) to contract-derived invariant tests (L4). A scaffolded app starts at L1, and each
        rung it has not reached reports the specific thing missing - so the ladder doubles as the list
        of what to do next. See <a href="/docs/verification">the verification ladder</a>.
      </p>
      <CodeBlock code={GATE} lang="bash" />

      <h2>Building agent features, not just serving them</h2>
      <p>
        The tools above let an agent work on your app. Three packages are for the opposite case, where
        the app you are building is itself an AI feature.
      </p>
      <p>
        <strong>
          <code>@nifrajs/prompt</code>
        </strong>{" "}
        binds an instruction to input and output schemas, so a model's reply is parsed before it
        becomes a value. Provider-agnostic - you supply the completion call, it owns the contract.
      </p>
      <CodeBlock code={PROMPT} lang="ts" />
      <p>
        <strong>
          <code>@nifrajs/agent-telemetry</code>
        </strong>{" "}
        adds child spans for tool calls on <code>/_nifra/tool/*</code> and the MCP endpoints, so an
        agent-facing route is as observable as any other.
      </p>
      <CodeBlock code={TELEMETRY} lang="ts" />
      <p>
        <strong>
          <code>@nifrajs/mcp-db</code>
        </strong>{" "}
        serves a SQLite database as its own MCP server, fail-closed: allowlisted schema tools by
        default, and read-only queries only when you opt in, with plan verification. Handing a model a
        database connection is not the same as handing it a query tool, and this is the second one.
      </p>

      <h2>Projects without a web config</h2>
      <p>
        A backend-only project - the shape <code>create-nifra</code>'s default template produces - has
        no <code>nifra.config.ts</code> and no <code>routes/</code> directory. The server starts
        anyway and serves every tool that does not need a loaded app: the docs and type corpora,{" "}
        <code>nifra_check</code>, <code>nifra_doctor</code>, <code>nifra_levels</code>,{" "}
        <code>nifra_test</code>. The page-oriented tools report that they need a web app when called,
        rather than the session failing to open.
      </p>

      <h2>Monorepos</h2>
      <p>
        Point the server at the repository root and it discovers each workspace app, namespacing that
        app's own <code>.tool()</code> declarations so two apps exposing the same tool name stay
        distinct.
      </p>
    </div>
  )
}
