import { CodeBlock } from "../../highlight"
import { docsMeta } from "../../meta"

// Pure content page - no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = docsMeta(
  "/docs/types-first",
  "Nifra - Types-first architecture",
  "Nifra infers route types from path literals and handlers automatically, with optional Standard Schemas for validation, explicit contracts, OpenAPI, and agent-readable APIs.",
)

const INLINE = `import { server } from "@nifrajs/core/server"

export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id, name: "Ada" }))
  // c.params.id is inferred from the path; the return type becomes the client response.
  .post("/users", () => ({ created: true }))

// No schema, annotation, or codegen is required for the route types.`

const SCHEMA = `import { t } from "@nifrajs/schema"

// Add a schema when the boundary needs runtime validation or a declared contract.
export const GetUser = {
  params: t.object({ id: t.string() }),
  response: t.object({
    id: t.string(),
    name: t.string(),
    role: t.union([t.literal("admin"), t.literal("user")]),
  }),
}`

const ROUTE = `import { server } from "@nifrajs/core/server"
import { GetUser } from "./schema"

export const app = server().get("/users/:id", GetUser, (c) => {
  // c.params.id is typed \`string\` - parsed from the path and validated at the boundary.
  return { id: c.params.id, name: "Ada", role: "admin" as const }
  //     ^ the return is checked against GetUser.response - a wrong shape is a tsc error.
})`

const CLIENT = `import { client } from "@nifrajs/client"
import type { app } from "./server"   // a TYPE import - server code never ships to the client

const api = client<typeof app>("https://api.example.com")

const res = await api.users({ id: "42" }).get()   // path + params autocomplete, no codegen
if (res.ok) {
  res.data.name        // typed from the route's response schema
} else {
  res.error            // client-call failures are returned, never thrown
}`

const OPENAPI = `import { server } from "@nifrajs/core/server"
import { openapi } from "@nifrajs/middleware"
import { GetUser } from "./schema"   // the contract defined above

// Generates an OpenAPI 3.1 document from your registered routes - lazily, on first request.
export const app = server()
  .use(openapi({ info: { title: "My API", version: "1.0.0" }, ui: true }))
  .get("/users/:id", GetUser, (c) => ({ id: c.params.id, name: "Ada", role: "admin" as const }))

// → GET /openapi.json   (the spec, generated from your schemas)
// → GET /reference      (a Scalar API-reference page, because \`ui: true\`)`

const MCP = `$ nifra context        # the same contract as compact text - pipe into any agent prompt
  GET /users/:id  →  params { id: string }  response { id, name, role }

$ nifra mcp            # the same data over an MCP server - Claude Code & Cursor read it`

export default function TypesFirst() {
  return (
    <div className="prose">
      <h1 className="page">Types-first architecture</h1>
      <p className="lead">
        Nifra starts with automatic inference. A route's path literal, handler context, and return
        value produce its TypeScript surface; add a Standard Schema when you need runtime validation,
        coercion, or an explicit request/response contract. The same server type then drives the
        no-codegen client and the agent-readable API surface.
      </p>

      <h2>Inline inference first</h2>
      <p>
        The chainable builder is fully type-inferred. Path parameters are parsed from the route
        pattern, handler context is typed automatically, and plain return values become the success
        response seen by the client. This is the quick-start style, similar to Elysia's inline route
        inference.
      </p>
      <CodeBlock code={INLINE} lang="ts" />

      <h2>Schemas at the trust boundary</h2>
      <p>
        Attach a Standard Schema when inputs must be validated before the handler runs, or when you
        want an explicit response contract. Path params are already inferred from <code>:id</code>;
        the <code>params</code> schema below adds runtime constraints/coercion as well.
      </p>
      <CodeBlock code={SCHEMA} lang="ts" />

      <h2>Runtime validation</h2>
      <p>
        Attach the schema to a route. Path params, query, and body are validated at the runtime
        boundary <em>before</em> your handler runs - invalid input is rejected with a 422, so the
        handler only ever sees well-formed data.
      </p>
      <CodeBlock code={ROUTE} lang="ts" />

      <h2>Inferred types</h2>
      <p>
        Without a schema, <code>c.params.id</code> is still <code>string</code> and the handler return
        is captured automatically. With a schema, its output types the handler and its declared
        <code>response</code> constrains what the handler may return. Change either the route or the
        contract and the typed client follows at compile time.
      </p>

      <h2>The typed client</h2>
      <p>
        The client is inferred from the server's <em>type</em> - no generators, no build step, no
        SDK to regenerate. Paths and params autocomplete; the response is typed from the route. A
        backend change that breaks a call is a compile error on the frontend.
      </p>
      <CodeBlock code={CLIENT} lang="ts" />

      <h2>Contract-first when the surface must be separate</h2>
      <p>
        Inline inference is the default. If the API needs to be shared, versioned, or implemented by
        more than one service, declare it with <code>defineContract</code> and connect handlers with{" "}
        <code>implement</code>. That keeps the contract type available without importing a server
        implementation into the client.
      </p>
      <p>
        See <a href="/docs/contract">Framework contract</a> for the decoupled form and its scaling
        guidance.
      </p>

      <h2>OpenAPI</h2>
      <p>
        The <code>openapi()</code> middleware builds an OpenAPI 3.1 document from your registered
        routes and their schemas - generated lazily on first request, never hand-written. Pass{" "}
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
          bring-your-own-validation route reads the body directly - cap and validate those yourself
          (see <a href="/docs/security">Security</a>'s <code>c.boundedBody</code>).
        </li>
        <li>
          The typed client infers from the server <em>type</em>, so it needs an{" "}
          <code>import type</code> of your app and TypeScript on the frontend. There is no runtime
          coupling - server code never ships to the client.
        </li>
        <li>
          The generated OpenAPI document is a structural subset of 3.1 derived from your schemas;
          it reflects exactly what the routes declare, not hand-authored prose.
        </li>
      </ul>
    </div>
  )
}
