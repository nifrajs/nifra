import { docsMeta } from "../../shared/meta"
import { CodeBlock } from "../../shared/highlight"

export const meta = docsMeta(
  "/docs",
  "Nifra - Getting started",
  "Get started with Nifra: typed backend, agentic UI, bounded agent runs, full-stack SSR, and portable deployment.",
)

const HELLO = `import { server } from "@nifrajs/core/server"

server()
  .get("/", () => ({ hello: "world" }))
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .listen(3000)`

const CLIENT = `import { client } from "@nifrajs/client"
import type { app } from "./server"

// The client infers the server's types - no codegen. Never throws: { data, error }.
const api = client<typeof app>("http://localhost:3000")
const { data, error } = await api.users({ id: "7" }).get()
//      ^? { id: string } | undefined`

const LOADER = `// routes/index.backend.ts - the loader runs on the server (in-process during SSR, no network),
// fully typed against your contract. This file never reaches the browser.
import { t } from "@nifrajs/schema"
import type { Route } from "./+types/index"

// The page receives exactly this shape; anything else the loader returns stays on the server.
export const loaderOutput = t.object({ id: t.string() })

export async function loader({ api }: Route.LoaderArgs) {
  const res = await api.users({ id: "7" }).get()
  return { id: res.ok ? res.data.id : "unknown" }
}`

const PAGE = `// routes/index.tsx - the page, typed from loaderOutput.
import type { Route } from "./+types/index"

export default function Page({ data }: Route.ComponentProps) {
  return <h1>{data.id}</h1>
}`

export default function Docs() {
  return (
    <div className="prose">
      <h1 className="page">Getting started</h1>
      <p className="lead">
        Nifra is a contract-first TypeScript framework for applications with agents in the loop. Start
        with just a typed backend - like Hono or Elysia - and the client infers its types with zero
        codegen. Add a full-stack UI, a bounded agent runtime, or page-local WebMCP when you need one:
        the same contracts drive all of them across Bun, Node, Deno, and the edge.
      </p>

      <h2>Start a project</h2>
      <p>
        The API starter is the shortest path to a running Nifra app. It includes the server entry,
        scripts, and a working example:
      </p>
      <pre className="code">
        <code>{`bun create nifra my-app
cd my-app
bun install
bun run dev`}</code>
      </pre>
      <p>
        To start with a full-stack React app instead, scaffold the <code>site</code> template. It
        includes the web runtime, renderer, and typed client used by the loader examples below:
      </p>
      <pre className="code">
        <code>{`bun create nifra my-app --template site --framework react
cd my-app
bun install
bun run dev`}</code>
      </pre>
      <p>
        See the <a href="/docs/cli">CLI guide</a> for other templates, UI frameworks, and deploy
        targets.
      </p>

      <h2>One app, two agent loops</h2>
      <p>
        A coding agent can inspect the live project, change it, run real requests, and prove the result.
        A user-facing agent can discover explicit page tools, stream progress into the UI, predict a
        state change, and reconcile it with the server. Both use the same typed capabilities and
        verification boundary. Start with the <a href="/docs/agents">agent layer</a> or the{" "}
        <a href="/docs/webmcp">WebMCP &amp; predictive UI guide</a> when you are ready to add them.
      </p>

      <h2>A backend-only alternative</h2>
      <p>
        If you are adding only an API to an existing project, install the core package directly. The
        scaffold above is not required for a backend-only app.
      </p>
      <pre className="code">
        <code>bun add @nifrajs/core</code>
      </pre>

      <h2>A server - no frontend required</h2>
      <p>
        Chainable and fully type-inferred. This is a complete app: <code>@nifrajs/core</code> alone is a
        production backend (routing, validation, middleware, auth, WebSockets). Run it on Bun with{" "}
        <code>.listen()</code>:
      </p>
      <CodeBlock code={HELLO} />

      <h2>An end-to-end-typed client</h2>
      <p>
        The server's types flow to the client - no schema duplication, no codegen - behind a
        never-throwing <code>{"{ data, error }"}</code> result. Add the client package when wiring a
        separate frontend; the full-stack template already includes it.
      </p>
      <pre className="code">
        <code>bun add @nifrajs/client</code>
      </pre>
      <CodeBlock code={CLIENT} />

      <h2>Loaders &amp; the full stack</h2>
      <p>
        In the <code>site</code> template, a route is two files: the page, and a{" "}
        <code>.backend.ts</code> half whose loader calls your backend in-process during SSR and
        whose <code>actions</code> handle mutations. Only what the loader's output schema declares
        reaches the browser. Add streaming, <code>defer()</code>, optimistic UI, and a keyed query
        cache as you grow. The data model is framework-agnostic, so the renderer stays replaceable.
        See <a href="/docs/structure">Project structure</a> for where code lives.
      </p>
      <CodeBlock code={LOADER} lang="ts" />
      <CodeBlock code={PAGE} />

      <h2>Deploy anywhere</h2>
      <ul>
        <li>
          <b>Bun</b> - <code>app.listen()</code> (native).
        </li>
        <li>
          <b>Node / Deno</b> - the <code>@nifrajs/node</code> / <code>@nifrajs/deno</code> adapters.
        </li>
        <li>
          <b>Cloudflare Workers / Pages</b> - edge build via <code>buildServer</code> +{" "}
          <code>toFetchHandler</code> (the exact way this self-hosted site is compiled and served).
        </li>
      </ul>

      <p className="lead" style={{ marginTop: 32 }}>
        See the <a href="/benchmarks">benchmarks</a> for how it performs.
      </p>
    </div>
  )
}
