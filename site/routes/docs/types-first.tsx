import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Types-first architecture",
  "One schema is the single source of truth: it drives runtime validation, inferred TypeScript types, the no-codegen typed client, an OpenAPI document, and the MCP contract your agents read.",
)

const SCHEMA = `import { t } from "@nifrajs/schema"

// One contract, defined once. Everything below is derived from it.
export const GetUser = {
  params: t.object({ id: t.string() }),
  response: t.object({
    id: t.string(),
    name: t.string(),
    role: t.union([t.literal("admin"), t.literal("user")]),
  }),
}`

const ROUTE = `import { server } from "@nifrajs/core"
import { GetUser } from "./schema"

export const app = server().get("/users/:id", GetUser, (c) => {
  // c.params.id is typed \`string\` — parsed from the path and validated at the boundary.
  return { id: c.params.id, name: "Ada", role: "admin" as const }
  //     ^ the return is checked against GetUser.response — a wrong shape is a tsc error.
})`

const CLIENT = `import { client } from "@nifrajs/client"
import type { app } from "./server"   // a TYPE import — server code never ships to the client

const api = client<typeof app>("https://api.example.com")

const res = await api.users({ id: "42" }).get()   // path + params autocomplete, no codegen
if (res.ok) {
  res.data.name        // typed from the route's response schema
} else {
  res.error            // client-call failures are returned, never thrown
}`

const OPENAPI = `import { openapi } from "@nifrajs/middleware"

// Generates an OpenAPI 3.1 document from your registered routes — lazily, on first request.
export const app = server()
  .use(openapi({ info: { title: "My API", version: "1.0.0" }, ui: true }))
  .get("/users/:id", GetUser, (c) => ({ id: c.params.id, name: "Ada", role: "admin" }))

// → GET /openapi.json   (the spec, generated from your schemas)
// → GET /reference      (a Scalar API-reference page, because \`ui: true\`)`

const MCP = `$ nifra context        # the same contract as compact text — pipe into any agent prompt
  GET /users/:id  →  params { id: string }  response { id, name, role }

$ nifra mcp            # the same data over an MCP server — Claude Code & Cursor read it`

export default function TypesFirst() {
  return (
    <div className="prose">
      <h1 className="page">Types-first architecture</h1>
      <p className="lead">
        In Nifra a single schema is the <b>source of truth</b>. The same definition drives runtime
        validation, inferred TypeScript types, the no-codegen typed client, an OpenAPI document, and
        the contract your coding agents read — so the five never drift apart.
      </p>

      <h2>One schema</h2>
      <p>
        Define request inputs and the response shape once with <code>t</code>. Nothing here is
        framework-specific; it's a plain object you attach to a route.
      </p>
      <CodeBlock code={SCHEMA} lang="ts" />

      <h2>Runtime validation</h2>
      <p>
        Attach the schema to a route. Path params, query, and body are validated at the runtime
        boundary <em>before</em> your handler runs — invalid input is rejected with a 400, so the
        handler only ever sees well-formed data.
      </p>
      <CodeBlock code={ROUTE} lang="ts" />

      <h2>Inferred types</h2>
      <p>
        The same schema types the handler: <code>c.params.id</code> is <code>string</code>, and the
        return value is checked against <code>response</code>. Change the schema and the handler
        stops compiling until it matches — types and validation can't disagree.
      </p>

      <h2>The typed client</h2>
      <p>
        The client is inferred from the server's <em>type</em> — no generators, no build step, no
        SDK to regenerate. Paths and params autocomplete; the response is typed from the route. A
        backend change that breaks a call is a compile error on the frontend.
      </p>
      <CodeBlock code={CLIENT} lang="ts" />

      <h2>OpenAPI</h2>
      <p>
        The <code>openapi()</code> middleware builds an OpenAPI 3.1 document from your registered
        routes and their schemas — generated lazily on first request, never hand-written. Pass{" "}
        <code>ui: true</code> to also serve a Scalar reference page.
      </p>
      <CodeBlock code={OPENAPI} lang="ts" />

      <h2>The MCP contract</h2>
      <p>
        The same routes and schemas feed coding agents. <code>nifra context</code> prints the live
        API surface as compact text, and <code>nifra mcp</code> serves it over the Model Context
        Protocol so Claude Code or Cursor read the real contract instead of guessing.
      </p>
      <CodeBlock code={MCP} lang="sh" />

      <h2>Known limitations</h2>
      <ul>
        <li>
          Validation only covers what you put in a schema. A raw-body, file-upload, or
          bring-your-own-validation route reads the body directly — cap and validate those yourself
          (see <a href="/docs/security">Security</a>'s <code>c.boundedBody</code>).
        </li>
        <li>
          The typed client infers from the server <em>type</em>, so it needs an{" "}
          <code>import type</code> of your app and TypeScript on the frontend. There is no runtime
          coupling — server code never ships to the client.
        </li>
        <li>
          The generated OpenAPI document is a structural subset of 3.1 derived from your schemas;
          it reflects exactly what the routes declare, not hand-authored prose.
        </li>
      </ul>
    </div>
  )
}
