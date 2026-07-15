import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — API & typed client",
  "Build a typed JSON API with server()/defineContract + validate inputs with any Standard Schema, then consume it from a zero-codegen, never-throwing typed client.",
)

const INLINE = `// doc-check: skip — uses the third-party \`zod\` schema lib (any Standard Schema works); install it to run this.
import { server } from "@nifrajs/core/server"
import { z } from "zod"   // any Standard Schema works: zod, valibot, arktype…

export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))                 // c.params is typed from the path
  .post("/users", { body: z.object({ name: z.string().min(1) }) }, // body validated at the boundary
    (c) => ({ created: c.body.name }))                             // c.body is the validated type
  .get("/search", { query: z.object({ page: z.string() }) },       // query validated too
    (c) => ({ page: c.query.page }))
  .listen(3000)`

const CONTRACT = `// doc-check: skip — uses the third-party \`zod\` schema lib + an illustrative \`users\` repo; install zod to run this.
import { defineContract, implement } from "@nifrajs/core/contract"
import { z } from "zod"

// 1. Declare the contract — methods, paths, and input schemas, no handlers.
//    Share this object between server and (optionally) other services.
export const contract = defineContract({
  listUsers: { method: "GET", path: "/users" },
  getUser:   { method: "GET", path: "/users/:id" },
  createUser:{ method: "POST", path: "/users", body: z.object({ name: z.string() }) },
  search:    { method: "GET", path: "/search", query: z.object({ page: z.string() }) },
})

// 2. Implement it — handlers are checked against the contract (path params, body, query all typed).
export const app = implement(contract, {
  listUsers: () => users.all(),
  getUser:   (c) => users.find(c.params.id),
  createUser:(c) => users.create(c.body.name),
  search:    (c) => ({ page: c.query.page }),
})`

const CLIENT = `import { client } from "@nifrajs/client"
import type { app } from "./server"

// Infers the server's types directly — no codegen, no schema duplication.
const api = client<typeof app>("https://api.example.com")

const { data } = await api.users({ id: "1" }).get()         // path param → /users/1
await api.users.post({ name: "Ada" })                       // POST body
await api.search.get({ query: { page: "3" } })              // query string
await api.users({ id: "1" }).posts({ postId: "2" }).get()   // nested params`

const RESULT = `// The client NEVER throws — every call returns a discriminated Result:
const res = await api.users({ id: "1" }).get()
if (res.ok) {
  res.data        // ^? { id: string }   (typed success body)
} else {
  res.status      // the HTTP status
  res.error.error // a stable error code, e.g. "not_found"
  res.error.issues // validation issues (message + path), when the body/query was rejected
}

// Or destructure { data, error } directly:
const { data, error } = await api.users.post({ name: "" })  // 422 if the schema rejects it`

const SET = `export const app = server()
  .post("/login", { body: z.object({ email: z.string() }) }, (c) => {
    c.set.status = 201                       // override the default 200 (204 when you return undefined)
    c.set.headers["x-request-id"] = reqId    // add/override a response header
    c.set.cookie("session", token, {         // HttpOnly + Secure + SameSite=Lax + Path=/ by default
      maxAge: 60 * 60 * 24,
    })
    return { ok: true }                      // still a plain object — the typed client stays in sync
  })
  .post("/logout", (c) => {
    c.set.deleteCookie("session")            // expire it immediately
    return { ok: true }
  })`

export default function Api() {
  return (
    <div className="prose">
      <h1 className="page">API &amp; typed client</h1>
      <p className="lead">
        Nifra is <b>contract-first</b>: you describe an HTTP API once — inline or as a standalone
        contract — and its types flow to the client with zero codegen. Inputs are validated at the
        trust boundary by any <a href="https://standardschema.dev">Standard Schema</a> (zod, valibot,
        arktype, …); outputs are inferred end-to-end.
      </p>
      <p>
        Everything on this page is just <code>@nifrajs/core</code> — no frontend, no build step. Use Nifra
        as a standalone backend the way you'd use Hono or Elysia, deploy it to any runtime, and reach
        for <a href="/docs/frameworks">the frontend adapters</a> only if and when you go full-stack.
      </p>

      <h2>An inline server</h2>
      <p>
        The chainable builder is the quickest start. Attach a <code>body</code> or <code>query</code>{" "}
        schema to a route and it's parsed-and-validated before your handler runs — <code>c.body</code>{" "}
        and <code>c.query</code> are the <i>validated</i> types, and a bad request gets a structured{" "}
        <code>422</code> automatically. Path params (<code>:id</code>) are typed from the pattern.
      </p>
      <CodeBlock code={INLINE} />

      <h2>Status, headers &amp; cookies (c.set)</h2>
      <p>
        Return a plain object and Nifra serializes it with a <code>200</code> (or <code>204</code> when
        you return <code>undefined</code>). To shape the response <i>without</i> giving up the typed
        return, use <code>c.set</code>: assign <code>c.set.status</code>, mutate{" "}
        <code>c.set.headers</code>, or call <code>c.set.cookie(name, value, opts?)</code> — cookies are{" "}
        <b>HttpOnly + Secure + SameSite=Lax + Path=/</b> by default, and <code>c.set.deleteCookie(name)</code>{" "}
        expires one. It's lazy: a handler that never touches <code>c.set</code> allocates nothing.
      </p>
      <CodeBlock code={SET} />
      <p className="caveat">
        Prefer <code>c.set</code> over returning a raw <code>Response</code>. A <code>Response</code>{" "}
        return makes the typed client infer <code>data: never</code>, so you silently lose drift
        detection for that route (<code>nifra check</code> flags it). <code>c.set</code> keeps your
        plain-object return fully typed.
      </p>
      <p>
        When you genuinely want a <code>Response</code> — an <b>error short-circuit</b> from a{" "}
        <code>derive</code> / <code>beforeHandle</code> (auth, rate limits) — <code>c.json(body, status?)</code>{" "}
        and <code>c.text(body, status?)</code> build one in a line:{" "}
        <code>{`throw c.json({ error: "unauthorized" }, 401)`}</code> instead of{" "}
        <code>{`new Response(JSON.stringify(…), { status: 401, headers: … })`}</code>. The second arg is a
        status number or a full <code>ResponseInit</code>, and both work whether you <code>return</code> or{" "}
        <code>throw</code> them. (In a route's happy path keep returning a plain object, as above, so the
        typed client stays in sync.)
      </p>
      <p>
        The request is on <code>c.req</code>, also available as <code>c.request</code> — the same name a
        page loader/action receives (which in turn also accepts <code>ctx.req</code>), so one name works
        in both places.
      </p>

      <h2>Contract-first (defineContract + implement)</h2>
      <p>
        For larger apps — or when the contract is shared across services — declare it with{" "}
        <code>defineContract</code> (methods, paths, schemas; no handlers), then{" "}
        <code>implement</code> it. Handlers are checked against the contract, so a wrong path param,
        body, or return type is a compile error. The result is the same <code>app</code> the inline
        builder produces.
      </p>
      <CodeBlock code={CONTRACT} />

      <h2>The end-to-end-typed client</h2>
      <p>
        <code>@nifrajs/client</code> takes the server's type (<code>client&lt;typeof app&gt;</code>) and
        exposes a fluent, fully-typed proxy — no generated SDK. Path params are call arguments; the body
        and query are typed from the route's schema.
      </p>
      <CodeBlock code={CLIENT} />

      <h2>Results never throw</h2>
      <p>
        Every call resolves to a discriminated <code>Result</code>: branch on <code>ok</code> (or
        destructure <code>{"{ data, error }"}</code>). Success carries the typed <code>data</code>;
        failure carries a structured <code>ApiError</code> — a stable <code>error</code> code plus
        validation <code>issues</code> — and the HTTP <code>status</code>. No try/catch, no surprise
        exceptions on a 404 or 422.
      </p>
      <CodeBlock code={RESULT} />
      <p>
        The same client runs in the browser and on the server. During SSR, a route's{" "}
        <a href="/docs/data">loader</a> calls it <b>in-process</b> (no network hop) via{" "}
        <code>ctx.api</code>. Next: <a href="/docs/routing">file routing</a>,{" "}
        <a href="/docs/data">loaders &amp; actions</a>, and <a href="/docs/plugins">plugins</a>.
      </p>
    </div>
  )
}
