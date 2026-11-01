import { docsMeta } from "../../shared/meta"
import { CodeBlock } from "../../shared/highlight"
import { href } from "@nifrajs/web-react/router"

export const meta = docsMeta(
  "/docs/migrate-backend",
  "Nifra - Migrating Express, Fastify, Hono & Elysia backends",
  "Move an Express, Fastify, Hono, or Elysia API to Nifra with direct route examples for routing, validation, responses, and deployment.",
)

const EXPRESS = `// Express
import express from "express"
const expressApp = express()
expressApp.get("/users/:id", (req, res) => res.json({ id: req.params.id }))
expressApp.post("/users", express.json(), (req, res) =>
  res.status(201).json({ id: crypto.randomUUID(), name: req.body.name }),
)

// Nifra
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body: t.object({ name: t.string() }) }, (c) => {
    c.set.status = 201
    return { id: crypto.randomUUID(), name: c.body.name }
  })`

const FASTIFY = `// Fastify
import Fastify from "fastify"
type UserParams = { id: string }
type UserBody = { name: string }
const fastify = Fastify()
fastify.get<{ Params: UserParams }>("/users/:id", async (request, reply) =>
  reply.send({ id: request.params.id }),
)
fastify.post<{ Body: UserBody }>(
  "/users",
  {
    schema: {
      body: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
    },
  },
  async (request, reply) =>
    reply.code(201).send({ id: crypto.randomUUID(), name: request.body.name }),
)

// Nifra
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body: t.object({ name: t.string() }) }, (c) => {
    c.set.status = 201
    return { id: crypto.randomUUID(), name: c.body.name }
  })`

const HONO = `// Hono
import { Hono } from "hono"
const legacy = new Hono()
legacy
  .get("/users/:id", (c) => c.json({ id: c.req.param("id") }))
  .post("/users", async (c) => {
    const body = await c.req.json<{ name: string }>()
    return c.json({ id: crypto.randomUUID(), name: body.name }, 201)
  })

// Nifra
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body: t.object({ name: t.string() }) }, (c) => {
    c.set.status = 201
    return { id: crypto.randomUUID(), name: c.body.name }
  })`

const ELYSIA = `// Elysia
import { Elysia, t as elysiaT } from "elysia"
const legacy = new Elysia()
  .get("/users/:id", ({ params }) => ({ id: params.id }))
  .post(
    "/users",
    ({ body }) => ({ id: crypto.randomUUID(), name: body.name }),
    { body: elysiaT.Object({ name: elysiaT.String() }) },
  )

// Nifra
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .post("/users", { body: t.object({ name: t.string() }) }, (c) => {
    c.set.status = 201
    return { id: crypto.randomUUID(), name: c.body.name }
  })`

export default function MigrateBackend() {
  return (
    <div className="prose">
      <h1 className="page">Migrate a backend</h1>
      <p className="lead">
        Migrate an API from Express, Fastify, Hono, or Elysia. The route handlers become chainable
        Nifra routes; request validation becomes part of the route contract; and the same app can
        serve a typed client on Bun, Node, Deno, or an edge runtime.
      </p>
      <p>
        Keep your database, service layer, and domain logic. Move one endpoint at a time, translate
        its request and response shape, then point the existing frontend at the new endpoint. Nifra
        can stay backend-only or mount under a full-stack app.
      </p>

      <h2 id="map">Map the backend primitives</h2>
      <table>
        <thead>
          <tr>
            <th>Express / Fastify / Hono / Elysia</th>
            <th>Nifra</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>app.get(path, handler)</code></td>
            <td><code>server().get(path, handler)</code>; path params are inferred from the path</td>
          </tr>
          <tr>
            <td><code>req</code> / <code>reply</code> / framework context</td>
            <td><code>c</code>, with <code>c.params</code>, <code>c.query</code>, <code>c.body</code>, and the Web Request</td>
          </tr>
          <tr>
            <td><code>res.json(x)</code>, <code>reply.send(x)</code>, <code>c.json(x)</code></td>
            <td>Return <code>x</code> for JSON, or return a Web <code>Response</code></td>
          </tr>
          <tr>
            <td>JSON Schema, TypeBox, or validator middleware</td>
            <td>Declare <code>body</code>, <code>query</code>, or <code>params</code> with <code>t</code>; validated values are typed in the handler</td>
          </tr>
          <tr>
            <td>Set a status or response header</td>
            <td><code>c.set.status</code> and <code>c.set.headers</code>, or return a <code>Response</code></td>
          </tr>
          <tr>
            <td>Middleware and plugins</td>
            <td><code>.use()</code> and the optional <code>@nifrajs/middleware</code> packages</td>
          </tr>
          <tr>
            <td>Generated client types or a separate SDK</td>
            <td><code>client&lt;typeof app&gt;()</code> from <code>@nifrajs/client</code>, no codegen</td>
          </tr>
          <tr>
            <td>OpenAPI and interactive API docs</td>
            <td>Generate a document from the route schemas with <code>nifra openapi</code></td>
          </tr>
        </tbody>
      </table>

      <h2 id="express">Express to Nifra</h2>
      <p>
        Replace <code>req.params</code> with <code>c.params</code>, body-parser middleware with a
        route schema, and <code>res.status().json()</code> with <code>c.set.status</code> plus a
        returned value. Keep Express middleware only where it is still needed during a staged
        migration.
      </p>
      <CodeBlock code={EXPRESS} lang="ts" />

      <h2 id="fastify">Fastify to Nifra</h2>
      <p>
        Move Fastify JSON Schema onto the route as Nifra&apos;s <code>body</code>,{" "}
        <code>query</code>, or <code>params</code> schema. Replace <code>reply.code().send()</code>{" "}
        with the response status and return value; move Fastify plugins to a Nifra plugin or{" "}
        <code>.use()</code> middleware where the behavior fits.
      </p>
      <CodeBlock code={FASTIFY} lang="ts" />

      <h2 id="hono">Hono to Nifra</h2>
      <p>
        The handler shape is close: <code>c.req.param("id")</code> becomes the typed{" "}
        <code>c.params.id</code>, and <code>c.json()</code> becomes a return. Move body parsing and
        validation into the route declaration so invalid input is rejected before the handler runs.
      </p>
      <CodeBlock code={HONO} lang="ts" />

      <h2 id="elysia">Elysia to Nifra</h2>
      <p>
        Both use a chainable route API and TypeBox-shaped schemas. In Nifra, import <code>t</code>{" "}
        from <code>@nifrajs/schema</code> and declare the schema beside the handler; the handler
        receives a typed context and returns its response. This keeps the route contract available
        to Nifra&apos;s inferred client and other adapters.
      </p>
      <CodeBlock code={ELYSIA} lang="ts" />

      <h2 id="runtime">Connect the API to a frontend or another runtime</h2>
      <p>
        The backend app itself is fetch-compatible. A frontend can call it in-process during SSR
        with <code>inProcessClient(app)</code>, while <code>apiPrefix: "/api"</code> also mounts the
        routes at <code>/api/*</code> over HTTP. The same app can be served through Bun,{" "}
        <code>@nifrajs/node</code>, <code>@nifrajs/deno</code>, or an edge fetch handler.
      </p>
      <p>
        For the UI migration, see{" "}
        <a href={href({ to: "/docs/migrate-frontend" })}>Migrate a frontend</a>. For route schemas,
        middleware, and deployment details, continue to{" "}
        <a href={href({ to: "/docs/api" })}>API &amp; typed client</a>,{" "}
        <a href={href({ to: "/docs/plugins" })}>Plugins &amp; middleware</a>, and{" "}
        <a href={href({ to: "/docs/deployment" })}>Deployment</a>.
      </p>
    </div>
  )
}
