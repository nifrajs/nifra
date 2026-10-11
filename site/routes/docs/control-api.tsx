import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/control-api",
  "Nifra - Control APIs (one schema, every client)",
  "Build an RPC-style control API on core routes: one schema per method gives request validation, a typed TypeScript client, and an OpenAPI 3.2 document whose SSE events let Swift, Kotlin, or Python clients be generated.",
)

const SERVER = `import { timingSafeEqual } from "node:crypto"
import { server } from "@nifrajs/core"
import { streaming } from "@nifrajs/core/sse"
import { t, toOpenAPI } from "@nifrajs/schema"

const token = process.env.CONTROL_TOKEN
if (token === undefined || token.length < 32) throw new Error("CONTROL_TOKEN must be 32+ characters")
const expected = Buffer.from(\`Bearer \${token}\`)
const authorized = (request: Request): boolean => {
  const given = Buffer.from(request.headers.get("authorization") ?? "")
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const Session = t.object({
  id: t.string(),
  status: t.union([t.literal("idle"), t.literal("running")]),
})
const TurnEvent = t.object({
  seq: t.integer({ minimum: 0 }),
  type: t.string(),
  text: t.optional(t.string()),
})

export const app = server()
  .use(streaming())
  .onRequest((request) =>
    authorized(request) ? undefined : Response.json({ error: "unauthorized" }, { status: 401 }),
  )
  .post(
    "/session/create",
    { body: t.object({ cwd: t.string({ minLength: 1, maxLength: 4096 }) }), response: Session },
    () => ({ id: crypto.randomUUID(), status: "idle" as const }),
  )
  .post(
    "/turn/send",
    {
      body: t.object({
        sessionId: t.string(),
        message: t.string({ minLength: 1, maxLength: 256 * 1024 }),
      }),
      response: t.object({ turnId: t.string() }),
      bodyLimit: 512 * 1024,
    },
    () => ({ turnId: crypto.randomUUID() }),
  )
  .sse(
    "/turn/events",
    { query: t.object({ turnId: t.string() }), sse: TurnEvent },
    (c, stream) => {
      const after = Number(c.req.headers.get("last-event-id") ?? -1)
      for (let seq = after + 1; seq < 3; seq++)
        stream.send({ seq, type: "assistant.delta", text: \`part \${seq}\` }, { id: String(seq) })
      stream.close()
    },
  )

export const spec = toOpenAPI(app, { openapiVersion: "3.2.0", title: "Control API", version: "1.0.0" })`

const CLIENT = `// doc-check: skip - fragment: app is the control server above, imported from its module.
import { client } from "@nifrajs/client"

const api = client<typeof app>("http://127.0.0.1:4100", {
  headers: { authorization: \`Bearer \${token}\` },
})

const session = await api.session.create.post({ cwd: "/work/repo" })
if (!session.ok) throw new Error(\`create failed: \${session.status}\`)

const subscription = api.turn.events.subscribe((event) => render(event.seq, event.text ?? ""), {
  query: { turnId },
  // After a dropped connection the client reconnects and sends Last-Event-ID itself.
})
// subscription.close() ends it.`

const EXPORT_SPEC = `// doc-check: skip - shell commands, not TypeScript.
// Write the document at build time, then hand it to any OpenAPI 3.2 generator.
bun -e 'import { spec } from "./control.ts"; await Bun.write("openapi.json", JSON.stringify(spec, null, 2))'
`

export default function ControlApi() {
  return (
    <div className="prose">
      <h1 className="page">Control APIs</h1>
      <p className="lead">
        A desktop app, a CLI, or a mobile companion that drives a local service needs a control API:
        a set of methods, a stream of events, and clients in more than one language. Write each
        method once as a route with a schema. The schema validates requests, types the TypeScript
        client, and describes the method in an OpenAPI document that generators turn into clients for
        other languages.
      </p>

      <h2>One file, three methods</h2>
      <p>
        Two methods take a JSON body and answer JSON. The third is a typed event stream. This file
        typechecks against the current packages.
      </p>
      <CodeBlock code={SERVER} />
      <ul>
        <li>
          <b>Methods are routes.</b> A method name like <code>session/create</code> is a path, so a
          call is <code>POST /session/create</code> and the typed client reads 
          <code>api.session.create.post(body)</code>. Use <code>POST</code> for anything that changes
          state; one envelope endpoint that dispatches on a method field would hide every method
          from the schema, the client, and the document.
        </li>
        <li>
          <b>The schema is the validator.</b> A body that does not match answers <code>422</code> 
          before the handler runs. <code>maxLength</code> bounds each field and 
          <code>bodyLimit</code> bounds the request as it arrives.
        </li>
        <li>
          <b>Authorization runs first.</b> An <code>onRequest</code> hook that returns a response
          ends the request before routing, so no method is reachable without the token. The
          comparison is constant-time, and the server refuses to start without a long token.
        </li>
        <li>
          <b>Retries.</b> A method that must not run twice declares 
          <code>idempotency</code> on its route, with <code>.use(idempotency())</code> from 
          <code>@nifrajs/core/idempotency-plugin</code> and a namespace per caller.
        </li>
      </ul>

      <h2>Event streams that resume</h2>
      <p>
        <code>{".sse(path, { sse: schema }, run)"}</code> declares the type of every event the stream
        sends. Give each event an <code>id</code> (here its sequence number). A browser 
        <code>EventSource</code>, or the typed client's <code>subscribe</code>, sends the last id it
        saw as <code>Last-Event-ID</code> when it reconnects, so the handler replays only what the
        client missed. Keep the events a reconnect may need in memory or in your own store: core
        sends the header, and what to replay is your service's to decide.
      </p>

      <h2>The TypeScript client</h2>
      <CodeBlock code={CLIENT} />
      <p>
        Every call is typed from the server's routes, with no generated code. A call returns a 
        <code>Result</code>: check <code>ok</code>, then read <code>data</code>, or 
        <code>status</code> and <code>error</code>.
      </p>

      <h2>Clients in other languages</h2>
      <p>
        <code>{"toOpenAPI(app, { openapiVersion: \"3.2.0\" })"}</code> from <code>@nifrajs/schema</code>
        describes each method's request and response, and each typed stream as 
        <code>text/event-stream</code> whose <code>itemSchema</code> is the SSE event: a 
        <code>data</code> field holding JSON that matches the route's event schema, plus 
        <code>event</code>, <code>id</code>, and <code>retry</code>. The event schema is also a named
        component (<code>TurnEventsEvent</code> here), so a generator emits a type for it. The 
        <code>openapi()</code> plugin from <code>@nifrajs/middleware</code> takes the same option and
        serves the document.
      </p>
      <CodeBlock code={EXPORT_SPEC} />
      <p>
        OpenAPI 3.1 has no field for the items of a stream. Without <code>openapiVersion</code> the
        document stays 3.1, declares the stream as a string, and carries the same item schema as 
        <code>x-itemSchema</code>; the named event component is there either way. A generator that
        reads only 3.1 still produces the event type, and your code decodes each 
        <code>data</code> line with it.
      </p>
    </div>
  )
}
