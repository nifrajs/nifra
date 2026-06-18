import { pageMeta } from "../../meta"
import { CodeBlock } from "../../highlight"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Migrating from Express, Hono, Fastify & Elysia",
  "Move a backend to Nifra: routing, middleware, validation, and body parsing map directly from Express, Hono, Fastify, and Elysia — and you gain a typed client, multi-runtime deploy, and optional SSR.",
)

const EXPRESS = `// Express
app.get("/users/:id", (req, res) => res.json({ id: req.params.id }))
app.post("/users", express.json(), (req, res) => res.status(201).json(create(req.body)))

// nifra — return the value (or a Response); c is Web-standard; the body is parsed + validated
server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body: t.object({ name: t.string() }) }, (c) => create(c.body))`

const HONO = `// Hono
app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }))

// nifra — nearly identical; params are a typed object, you return the value
server().get("/users/:id", (c) => ({ id: c.params.id }))`

export default function MigrateBackend() {
  return (
    <div className="prose">
      <h1 className="page">Migrating a backend</h1>
      <p className="lead">
        Nifra's <code>server()</code> is a chainable, Web-standard router — the move from Express, Hono,
        Fastify, or Elysia is mostly mechanical renames. What you gain: an end-to-end-typed client with
        zero codegen, schema validation built into the route, the same app on Bun / Node / Deno / the
        edge, and an SSR frontend whenever you want one.
      </p>

      <h2>How the concepts map</h2>
      <table>
        <thead>
          <tr>
            <th>Express / Hono / Fastify</th>
            <th>Nifra</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>`app.get(path, handler)`</td>
            <td>
              <code>server().get(path, handler)</code> — chainable, fully type-inferred
            </td>
          </tr>
          <tr>
            <td>`req` / `res` · Hono `Context`</td>
            <td>
              <code>c</code> — `c.req`, `c.params`, `c.query`; <b>return</b> a value (JSON) or a{" "}
              <code>Response</code>
            </td>
          </tr>
          <tr>
            <td>`app.use(mw)` · Hono middleware</td>
            <td>
              <code>.use()</code> + the <code>@nifrajs/middleware</code> pack (CORS, auth, rate limit, …)
            </td>
          </tr>
          <tr>
            <td>`express.json()` / body parsing</td>
            <td>built in — declare a schema and the parsed body is typed</td>
          </tr>
          <tr>
            <td>Fastify JSON schema · `zod` middleware · Elysia `t`</td>
            <td>
              <code>{"{ body, query, params }"}</code> validated by <code>t</code> (TypeBox) or any{" "}
              <a href="https://standardschema.dev">Standard Schema</a>
            </td>
          </tr>
          <tr>
            <td>`res.json(x)` / `reply.send(x)` / `c.json(x)`</td>
            <td>
              <code>return x</code>
            </td>
          </tr>
          <tr>
            <td>`app.listen(3000)`</td>
            <td>
              <code>app.listen()</code> (Bun) · <code>@nifrajs/node</code> · <code>@nifrajs/deno</code> ·{" "}
              <code>toFetchHandler</code> (edge)
            </td>
          </tr>
          <tr>
            <td>OpenAPI plugins / swagger</td>
            <td>generated from the same `t` schemas — no second source of truth</td>
          </tr>
        </tbody>
      </table>

      <h2>Express → Nifra</h2>
      <p>
        The handler returns its result instead of calling <code>res.json</code>, and validation moves
        onto the route. The client then infers all of this for free.
      </p>
      <CodeBlock code={EXPRESS} lang="ts" />

      <h2>Hono → Nifra</h2>
      <p>
        The closest of the routers — <code>c.req.param("id")</code> becomes a typed{" "}
        <code>c.params.id</code>, and you return the value rather than <code>c.json(...)</code>. Nifra
        adds the typed client, schema validation, multi-runtime deploy, and (if you want it) SSR.
      </p>
      <CodeBlock code={HONO} lang="ts" />

      <h2>Fastify &amp; Elysia</h2>
      <ul>
        <li>
          <b>Fastify</b> — its per-route JSON-schema validation maps directly to Nifra's{" "}
          <code>{"{ body, query, params }"}</code>; plugins become Nifra plugins; <code>reply.send</code>{" "}
          becomes a return.
        </li>
        <li>
          <b>Elysia</b> — the closest peer (Bun, typed, TypeBox <code>t</code>). The shapes are nearly
          1:1: <code>.get/.post</code> + a <code>t</code> schema, and an Eden-style typed client. You
          gain Node / Deno / edge portability and an optional SSR frontend on five UI libraries.
        </li>
      </ul>
      <p>
        Then connect a database (<a href="/docs/database">Database</a>) and, if you're going
        full-stack, see <a href="/docs/migrate-frontend">Migrating a meta-framework</a>.
      </p>
    </div>
  )
}
