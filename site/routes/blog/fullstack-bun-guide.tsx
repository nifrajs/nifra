import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Building a full-stack TypeScript app on Bun",
  "A practical guide to building a typed full-stack app on Bun with nifra: file-based routes, typed loaders, server functions, validation at the boundary, and deploying the same app to Node, Deno, or the edge.",
)

const SCAFFOLD = `bunx create-nifra taskboard --template site --framework react
cd taskboard && bun install
bun run dev`

const BACKEND = `// backend.ts - the composition root. Routes declared here are typed
// all the way into the frontend, with zero codegen.
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

const tasks: Array<{ id: string; title: string; done: boolean }> = []

export const backend = server()
  .get("/api/tasks", () => tasks)
  .post(
    "/api/tasks",
    { body: t.object({ title: t.string({ minLength: 1 }) }) },
    (c) => {
      const task = { id: crypto.randomUUID(), title: c.body.title, done: false }
      tasks.push(task)
      return task
    },
  )`

const LOADER = `// routes/index.tsx - a page with a typed loader. The loader runs on the
// server, calls the backend in-process (no HTTP hop), and its return value
// flows to the component - typed against the backend contract.
export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.api.tasks.get()
  return { tasks: res.data }
}

export default function Home(props: { data: LoaderData<typeof loader> }) {
  return (
    <ul>
      {props.data.tasks.map((t) => (
        <li key={t.id}>{t.title}</li>
      ))}
    </ul>
  )
}`

const DRIFT = `// Rename \`title\` to \`name\` in backend.ts and the frontend fails to COMPILE:
//
//   routes/index.tsx: Property 'title' does not exist on type
//     '{ id: string; name: string; done: boolean }'
//
// That is the whole pitch of an inferred contract: drift is a build error,
// not a production incident.`

export default function FullstackBunGuide() {
  return (
    <article className="prose">
      <h1>Building a full-stack TypeScript app on Bun</h1>
      <p>
        <em>2026-08-04</em>
      </p>

      <p className="lead">
        Bun made the runtime fast and the tooling unified. What it does not give you is an
        application architecture: routing, rendering, validation, and a typed line between your
        server and your frontend. This is the practical walkthrough of that layer with nifra - a
        full-stack TypeScript framework built Bun-first - from scaffold to a deployable app.
      </p>

      <h2>Scaffold</h2>
      <CodeBlock code={SCAFFOLD} lang="bash" />
      <p>
        The <code>site</code> template is the full-stack shape: file-based routes under{" "}
        <code>routes/</code>, a backend composition root at <code>backend.ts</code>, SSR with
        hydration, and a typed client wiring them together. Swap <code>react</code> for{" "}
        <code>vue</code>, <code>solid</code>, <code>svelte</code>, or <code>preact</code> - same
        framework underneath, same typed contract.
      </p>

      <h2>A typed backend in one file</h2>
      <CodeBlock code={BACKEND} lang="ts" />
      <p>
        Two things are load-bearing here. The <code>body</code> schema is not documentation - it is
        enforced at the boundary, so the handler receives <code>c.body</code> already validated and
        typed, and a malformed request never reaches your code. And the whole app's route registry
        is carried in <code>typeof backend</code>, which is what makes the next part work.
      </p>

      <h2>Pages that cannot drift from the API</h2>
      <CodeBlock code={LOADER} lang="tsx" />
      <p>
        The client is inferred from the server type - no OpenAPI generation step, no hand-written
        client to maintain. Which means:
      </p>
      <CodeBlock code={DRIFT} lang="ts" />

      <h2>Validation is the default, not a discipline</h2>
      <p>
        Every route that accepts input declares a schema, in any{" "}
        <a href="/docs/data">Standard Schema</a> library - Zod, Valibot, ArkType, or a hand-rolled
        validator. This is a security posture, not a convenience: unvalidated input on a public
        endpoint is mass assignment waiting to happen, so the framework makes the validated path the
        shortest one. Server functions take it further - JSON-only content type and same-origin
        checks are enforced for you (<a href="/docs/server-functions">why</a>).
      </p>

      <h2>The dev loop, including the AI half</h2>
      <p>
        <code>bun run dev</code> gives you HMR and SSR. The part most frameworks do not have:{" "}
        <code>nifra check</code> verifies your app - schema coverage, route hygiene, drift between
        contract and code - and returns structured output. If an AI agent writes part of your app
        (increasingly, it does), it reads those failures and fixes its own mistakes. nifra's docs,
        examples, and API types are also a <a href="/blog/docs-as-mcp">live MCP server</a> your
        assistant can query mid-task.
      </p>

      <h2>Deploying - and the runtime escape hatch</h2>
      <p>
        <code>nifra build</code> produces the production server. On Bun, our published benchmarks
        put the framework at 101% of a hand-rolled <code>Bun.serve</code> baseline - the layer costs
        nothing measurable. And because runtimes are adapters, the same app deploys to Node, Deno,
        or edge workers unchanged if your infrastructure demands it. Numbers and methodology:{" "}
        <a href="/benchmarks">benchmarks</a>.
      </p>

      <h2>Where to go next</h2>
      <ul>
        <li>
          <a href="/docs">The docs</a> - routing, loaders, mutations, ISR, jobs, caching, auth.
        </li>
        <li>
          <a href="/compare">How nifra compares</a> to Next.js, Elysia, Hono, and Fastify.
        </li>
        <li>
          <a href="/docs/agents">Agent setup</a> - connect your AI assistant to the live docs
          endpoint.
        </li>
      </ul>
    </article>
  )
}
