import { pageMeta } from "../../meta"
import { CodeBlock } from "../../highlight"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Getting started",
  "Get started with Nifra: install, server, typed client, loaders, deploy.",
)

const HELLO = `import { server } from "@nifrajs/core/server"

server()
  .get("/", () => ({ hello: "world" }))
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .listen(3000)`

const CLIENT = `import { client } from "@nifrajs/client"
import type { app } from "./server"

// The client infers the server's types — no codegen. Never throws: { data, error }.
const api = client<typeof app>("http://localhost:3000")
const { data, error } = await api.users({ id: "7" }).get()
//      ^? { id: string } | undefined`

const LOADER = `// A route's loader runs on the server (in-process during SSR, no network),
// fully typed against your contract.
export async function loader({ api }: LoaderArgs<typeof app>) {
  const res = await api.users({ id: "7" }).get()
  return { user: res.data }
}

export default function Page(props: { data: LoaderData<typeof loader> }) {
  return <h1>{props.data.user?.id}</h1>
}`

export default function Docs() {
  return (
    <div className="prose">
      <h1 className="page">Getting started</h1>
      <p className="lead">
        Nifra is a contract-first TypeScript framework. Start with just a typed backend — like Hono or
        Elysia — and the client infers its types with zero codegen. Add a frontend only when you need
        one: the same route model then drives SSR across React, Solid, Vue, Preact, and Svelte, on
        Bun, Node, Deno, and the edge.
      </p>

      <h2>Install</h2>
      <pre className="code">
        <code>bun add @nifrajs/core</code>
      </pre>

      <h2>A server — no frontend required</h2>
      <p>
        Chainable and fully type-inferred. This is a complete app: <code>@nifrajs/core</code> alone is a
        production backend (routing, validation, middleware, auth, WebSockets). Run it on Bun with{" "}
        <code>.listen()</code>:
      </p>
      <CodeBlock code={HELLO} />

      <h2>An end-to-end-typed client</h2>
      <p>
        The server's types flow to the client — no schema duplication, no codegen — behind a
        never-throwing <code>{"{ data, error }"}</code> result.
      </p>
      <CodeBlock code={CLIENT} />

      <h2>Loaders &amp; the full stack</h2>
      <p>
        Route loaders call your backend in-process during SSR; <code>actions</code> handle
        mutations. Add streaming, <code>defer()</code>, optimistic UI, and a keyed query cache as
        you grow. The data model is framework-agnostic, so the renderer stays replaceable.
      </p>
      <CodeBlock code={LOADER} />

      <h2>Deploy anywhere</h2>
      <ul>
        <li>
          <b>Bun</b> — <code>app.listen()</code> (native).
        </li>
        <li>
          <b>Node / Deno</b> — the <code>@nifrajs/node</code> / <code>@nifrajs/deno</code> adapters.
        </li>
        <li>
          <b>Cloudflare Workers / Pages</b> — edge build via <code>buildServer</code> +{" "}
          <code>toFetchHandler</code> (the exact way this self-hosted site is compiled and served).
        </li>
      </ul>

      <p className="lead" style={{ marginTop: 32 }}>
        See the <a href="/benchmarks">benchmarks</a> for how it performs.
      </p>
    </div>
  )
}
