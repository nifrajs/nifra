import { CodeBlock } from "../../highlight"
import { docsMeta } from "../../meta"

// Pure content page - no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = docsMeta(
  "/docs/api",
  "Nifra - API & typed client",
  "Build a typed JSON API with server()/defineContract + validate inputs with any Standard Schema, then consume it from a zero-codegen, never-throwing typed client.",
)

const INLINE = `// doc-check: skip - uses the third-party \`zod\` schema lib (any Standard Schema works); install it to run this.
import { server } from "@nifrajs/core/server"
import { z } from "zod"   // any Standard Schema works: zod, valibot, arktype…

export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))                 // c.params is typed from the path
  .post("/users", { body: z.object({ name: z.string().min(1) }) }, // body validated at the boundary
    (c) => ({ created: c.body.name }))                             // c.body is the validated type
  .get("/search", { query: z.object({ page: z.string() }) },       // query validated too
    (c) => ({ page: c.query.page }))
  .listen(3000)`

const CONTRACT = `// doc-check: skip - uses the third-party \`zod\` schema lib + an illustrative \`users\` repo; install zod to run this.
import { defineContract, implement } from "@nifrajs/core/contract"
import { z } from "zod"

// 1. Declare the contract - methods, paths, and input schemas, no handlers.
//    Share this object between server and (optionally) other services.
export const contract = defineContract({
  listUsers: { method: "GET", path: "/users" },
  getUser:   { method: "GET", path: "/users/:id" },
  createUser:{ method: "POST", path: "/users", body: z.object({ name: z.string() }) },
  search:    { method: "GET", path: "/search", query: z.object({ page: z.string() }) },
})

// 2. Implement it - handlers are checked against the contract (path params, body, query all typed).
export const app = implement(contract, {
  listUsers: () => users.all(),
  getUser:   (c) => users.find(c.params.id),
  createUser:(c) => users.create(c.body.name),
  search:    (c) => ({ page: c.query.page }),
})`

const CLIENT = `import { client } from "@nifrajs/client"
import type { app } from "./server"

// Infers the server's types directly - no codegen, no schema duplication.
const api = client<typeof app>("https://api.example.com")

const { data } = await api.users({ id: "1" }).get()         // path param → /users/1
await api.users.post({ name: "Ada" })                       // POST body
await api.search.get({ query: { page: "3" } })              // query string
await api.users({ id: "1" }).posts({ postId: "2" }).get()   // nested params
await api.files("report.json").get()                        // /files/:name.json → the segment as sent`

const RESULT = `// The client NEVER throws - every call returns a discriminated Result:
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
    return { ok: true }                      // still a plain object - the typed client stays in sync
  })
  .post("/logout", (c) => {
    c.set.deleteCookie("session")            // expire it immediately
    return { ok: true }
  })`

const NOT_FOUND = `import { notFound } from "@nifrajs/core/not-found"
import { server } from "@nifrajs/core/server"

export const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .use(
    notFound(({ pathname, header }) => {
      // A section that moved: a redirect is sent as the redirect it is.
      if (pathname.startsWith("/old/")) {
        return new Response(null, {
          status: 308,
          headers: { location: \`/docs/\${pathname.slice(5)}\` },
        })
      }
      // A browser gets a page. It is returned as a 200 here and sent as a 404.
      if (header("accept")?.includes("text/html")) {
        return new Response("<h1>Nothing here</h1>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }
      return undefined // anything else keeps the default { ok: false, error: "not_found" }
    }),
  )`

const OPTIONAL_PARAMS = `import { server } from "@nifrajs/core/server"

export const app = server()
  // GET /users and GET /users/42
  .get("/users/:id?", (c) => (c.params.id === undefined ? { all: true } : { id: c.params.id }))
  // GET /archive, GET /archive/2026 and GET /archive/2026/09
  .get("/archive/:year?/:month?", (c) => ({ year: c.params.year, month: c.params.month }))`

const PARAM_CONSTRAINTS = `import { server } from "@nifrajs/core/server"

export const app = server()
  // /users/me is its own route; /users/42 is this one; /users/ada is a 404
  .get("/users/me", () => ({ me: true }))
  .get("/users/:id{[0-9]+}", (c) => ({ id: Number(c.params.id) }))
  // A list of values, and a count: exactly two capital letters
  .get("/img/:size{thumb|full}/:file", (c) => ({ size: c.params.size, file: c.params.file }))
  .get("/countries/:code{[A-Z]{2}}", (c) => ({ code: c.params.code }))
  // Inside a segment, and optional at the end of a path
  .get("/files/:name.:ext{png|jpg}", (c) => ({ name: c.params.name, ext: c.params.ext }))
  .get("/posts/:page{[0-9]+}?", (c) => ({ page: c.params.page ?? "1" }))`

const METHOD_ROUTES = `import { server } from "@nifrajs/core/server"
import { all, method } from "@nifrajs/core/methods"

export const app = server()
  // GET, POST, PUT, PATCH, DELETE, HEAD and OPTIONS /echo
  .use(all("/echo", (c) => ({ method: c.req.method })))
  // A method outside the standard seven
  .use(method("PURGE", "/cache/:key", (c) => ({ purged: c.params.key })))
  // A list of methods, one handler
  .use(method(["GET", "POST"], "/search", (c) => ({ q: c.query.get("q") })))`

export default function Api() {
  return (
    <div className="prose">
      <h1 className="page">API &amp; typed client</h1>
      <p className="lead">
        Nifra is <b>contract-first</b>: you describe an HTTP API once - inline or as a standalone
        contract - and its types flow to the client with zero codegen. Inputs are validated at the
        trust boundary by any <a href="https://standardschema.dev">Standard Schema</a> (zod, valibot,
        arktype, …); outputs are inferred end-to-end.
      </p>
      <p>
        Everything on this page is just <code>@nifrajs/core</code> - no frontend, no build step. Use Nifra
        as a standalone backend the way you'd use Hono or Elysia, deploy it to any runtime, and reach
        for <a href="/docs/frameworks">the frontend adapters</a> only if and when you go full-stack.
      </p>

      <h2>An inline server</h2>
      <p>
        The chainable builder is the quickest start. Attach a <code>body</code> or <code>query</code>{" "}
        schema to a route and it's parsed-and-validated before your handler runs - <code>c.body</code>{" "}
        and <code>c.query</code> are the <i>validated</i> types, and a bad request gets a structured{" "}
        <code>422</code> automatically. Path params (<code>:id</code>) are typed from the pattern.
      </p>
      <CodeBlock code={INLINE} />

      <h2>Optional path params</h2>
      <p>
        A path can end in optional params, written <code>:name?</code>. The route then serves the path
        with the param and without it, and the param is typed <code>string | undefined</code>:
      </p>
      <CodeBlock code={OPTIONAL_PARAMS} />
      <ul>
        <li>
          <b>Only at the end, only whole segments.</b> Several in a row are filled left to right, so{" "}
          <code>/archive/:year?/:month?</code> serves three paths and never a month without a year. A{" "}
          <code>?</code> anywhere else (<code>/a/:id?/b</code>, <code>/v-:id?</code>) is ordinary text,
          which no request path can contain; <code>nifra check</code> reports it as{" "}
          <code>NF-C026</code>.
        </li>
        <li>
          <b>It is one route per path it serves.</b> <code>/users/:id?</code> is <code>/users</code> and{" "}
          <code>/users/:id</code> with the same handler, schema and hooks, and that is how it appears
          in <code>app.routes()</code>, OpenAPI (two operations; the shorter one has no <code>id</code>{" "}
          parameter) and the typed client (<code>api.users.get()</code> and{" "}
          <code>{`api.users({ id }).get()`}</code>).
        </li>
        <li>
          <b>An absent param is absent,</b> not an empty string: it is missing from{" "}
          <code>c.params</code>. A <code>params</code> schema has to allow that, or the shorter path
          answers <code>422</code>.
        </li>
        <li>
          <b>A path can be registered once.</b> <code>GET /users</code> next to{" "}
          <code>GET /users/:id?</code> throws at registration, because both serve{" "}
          <code>GET /users</code>. Nothing of a rejected route is left registered.
        </li>
      </ul>
      <p className="caveat">
        Other param modifiers (<code>:id+</code>, <code>:id*</code>, <code>{":id(\\d+)"}</code>) are not
        part of the path grammar and match as literal text. Where that text is intended, put{" "}
        <code>{"// nifra-expect param-modifier"}</code> above the registration.
      </p>

      <h2>Param constraints</h2>
      <p>
        A param can say which values it accepts, written in braces after the name. A request whose
        value does not fit is not served by that route, so it falls to another route or to a{" "}
        <code>404</code>. The param is still a <code>string</code>.
      </p>
      <CodeBlock code={PARAM_CONSTRAINTS} />
      <p>A constraint is one of two things:</p>
      <ul>
        <li>
          <b>One character class, with an optional count.</b> <code>[0-9]</code>,{" "}
          <code>[a-z0-9_-]</code>, <code>{"\\d"}</code> or <code>{"\\w"}</code>, followed by nothing
          (exactly one character), <code>+</code>, <code>{"{n}"}</code>, <code>{"{n,}"}</code> or{" "}
          <code>{"{n,m}"}</code>. A class holds letters, digits, ranges of them, <code>{"\\d"}</code>,{" "}
          <code>{"\\w"}</code> and the characters <code>{". _ ~ ! $ & ' ( ) + , ; = @ -"}</code>. There
          is no negated class, and a count starts at one.
        </li>
        <li>
          <b>A list of two or more values,</b> separated by <code>|</code>:{" "}
          <code>{":ext{png|jpg|webp}"}</code>. A value is letters, digits, <code>.</code>,{" "}
          <code>_</code>, <code>~</code> and <code>-</code>.
        </li>
      </ul>
      <p>
        Anything else in braces (<code>{":id{int}"}</code>, <code>{":id{[0-9]+|[a-z]+}"}</code>,{" "}
        <code>{":id{.+}"}</code>) is not a constraint. It is literal text, as before, and{" "}
        <code>nifra check</code> reports it as <code>NF-C026</code>. In a JavaScript string{" "}
        <code>{"\\d"}</code> is written <code>{'"\\\\d"'}</code>.
      </p>
      <ul>
        <li>
          <b>The value is checked as it was sent,</b> before percent-decoding. <code>/users/4%32</code>{" "}
          does not fit <code>{":id{[0-9]+}"}</code>, although it decodes to <code>42</code>. A handler
          on a constrained route therefore never sees a decoded character the constraint does not
          allow. A broader route beside it still serves that request and sees <code>42</code>.
        </li>
        <li>
          <b>The narrowest route answers, whatever the order of registration.</b> Literal text is
          tried first, then a list, then a class, then a bare <code>:param</code>, then a wildcard.
          Between two constraints of a kind, the one that accepts fewer values is tried first, so{" "}
          <code>{":id{[0-9]+}"}</code> is tried before <code>{":id{[0-9a-f]+}"}</code>.
        </li>
        <li>
          <b>A method the narrowest route does not have is a 405.</b> With{" "}
          <code>{"GET /users/:id{[0-9]+}"}</code> and <code>POST /users/:name</code>,{" "}
          <code>POST /users/42</code> answers <code>405</code> with <code>Allow: GET, HEAD</code>. It is
          the same rule a literal route follows beside a param route.
        </li>
        <li>
          <b>Two spellings of one constraint are one route.</b> <code>{":id{[0-9]+}"}</code>,{" "}
          <code>{":id{\\d+}"}</code> and <code>{":id{[0-9]{1,}}"}</code> accept the same values, so
          registering two of them for one method throws <code>DUPLICATE_ROUTE</code>, and different
          methods on them share one <code>Allow</code> list.
        </li>
        <li>
          <b>Inside a segment, the text around the params is placed first.</b>{" "}
          <code>{"/files/:name.:ext{png|jpg}"}</code> splits <code>a.b.png</code> at its first dot, into{" "}
          <code>a</code> and <code>b.png</code>, and then the constraint refuses it. The router does
          not look for another split.
        </li>
        <li>
          <b>Overlap checks know about constraints.</b> <code>/users/me</code> and{" "}
          <code>{"/users/:id{[0-9]+}"}</code> serve no request in common, so <code>nifra check</code>{" "}
          (<code>NF-C024</code>) has nothing to report. A constrained route beside a bare{" "}
          <code>:param</code> route still overlaps and is still reported; mark the pair with{" "}
          <code>{"// nifra-expect route-overlap"}</code> where it is intended.
        </li>
        <li>
          <b>OpenAPI and the typed client use the bare name.</b> The path is{" "}
          <code>{"/users/{id}"}</code>; the parameter's schema is{" "}
          <code>{'{ type: "string", pattern: "^[0-9]+$" }'}</code> for a class and an <code>enum</code>{" "}
          for a list, unless the route declares a <code>params</code> schema. The client call is{" "}
          <code>{'api.users({ id: "42" }).get()'}</code>. The client does not check the value: a value
          that does not fit is sent, and answered by whichever route it does match. Where two param
          routes share a position, give their params different names so that the call picks the route
          by name.
        </li>
        <li>
          <b>Not in a page route's file name.</b> <code>@nifrajs/web</code> refuses a constraint in{" "}
          <code>routes/</code>, because links and prerendered paths are rebuilt from the param's name.
          Check the value in the page's loader.
        </li>
      </ul>

      <h2>Several methods, custom methods (all, method)</h2>
      <p>
        <code>all()</code> registers one handler under every standard method, and <code>method()</code>{" "}
        under the method or methods you name, including one outside the standard seven. Both come
        from <code>@nifrajs/core/methods</code> and are applied with <code>use()</code>:
      </p>
      <CodeBlock code={METHOD_ROUTES} />
      <ul>
        <li>
          <b>Each method is an ordinary route.</b> It shows in <code>app.routes()</code>, takes the
          same schema and hooks, works inside <code>group()</code>, and collides with a route already
          registered for that method and path. One call is one registration: if any of its routes is
          refused, none is added.
        </li>
        <li>
          <b>There is no catch-all.</b> <code>all()</code> is the seven standard methods, and a
          request with any other method is still a <code>405</code> with an <code>Allow</code>{" "}
          header. To hand every request under a path to another handler whatever its method, use{" "}
          <code>mount()</code>.
        </li>
        <li>
          <b>A method name</b> is case-insensitive and registered uppercase: letters, digits and
          hyphens, starting with a letter, at most 32 characters. <code>TRACE</code>,{" "}
          <code>CONNECT</code> and <code>TRACK</code> are refused, and so is any other value, with{" "}
          <code>INVALID_METHOD</code> when <code>method()</code> is called.
        </li>
        <li>
          <b>A custom method has no typed-client call and no OpenAPI entry.</b> The standard methods
          in the same call keep both. Call a custom one with{" "}
          <code>{`fetch(url, { method: "PURGE" })`}</code>.
        </li>
        <li>
          <b>An assurance policy selects standard methods only.</b> A rule with <code>methods</code>{" "}
          never matches a custom-method route, so classify it with a path rule. Left unmatched, it is
          reported as <code>unclassified-route</code>.
        </li>
      </ul>
      <p className="caveat">
        Whether a custom method reaches the app is up to the runtime's HTTP parser.{" "}
        <code>PROPFIND</code>, <code>REPORT</code>, <code>PURGE</code> and <code>QUERY</code> arrive on
        Bun, Node, Deno and workerd. A token the parser does not know is answered by the runtime
        itself on Bun, Node and workerd, before the app sees it. The compact server from{" "}
        <code>@nifrajs/edge</code> has no <code>use()</code> and takes neither function.
      </p>

      <h2>Status, headers &amp; cookies (c.set)</h2>
      <p>
        Return a plain object and Nifra serializes it with a <code>200</code> (or <code>204</code> when
        you return <code>undefined</code>). To shape the response <i>without</i> giving up the typed
        return, use <code>c.set</code>: assign <code>c.set.status</code>, mutate{" "}
        <code>c.set.headers</code>, or call <code>c.set.cookie(name, value, opts?)</code> - cookies are{" "}
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
        When you genuinely want a <code>Response</code> - an <b>error short-circuit</b> from a{" "}
        <code>derive</code> / <code>beforeHandle</code> (auth, rate limits) - <code>c.json(body, status?)</code>{" "}
        and <code>c.text(body, status?)</code> build one in a line:{" "}
        <code>{`throw c.json({ error: "unauthorized" }, 401)`}</code> instead of{" "}
        <code>{`new Response(JSON.stringify(…), { status: 401, headers: … })`}</code>. The second arg is a
        status number or a full <code>ResponseInit</code>, and both work whether you <code>return</code> or{" "}
        <code>throw</code> them. (In a route's happy path keep returning a plain object, as above, so the
        typed client stays in sync.)
      </p>
      <p>
        The request is on <code>c.req</code>, also available as <code>c.request</code> - the same name a
        page loader/action receives (which in turn also accepts <code>ctx.req</code>), so one name works
        in both places.
      </p>

      <h2>Requests no route matched (notFound)</h2>
      <p>
        A path no route matches is answered <code>404</code> with{" "}
        <code>{`{ "ok": false, "error": "not_found" }`}</code>. To answer it yourself, apply{" "}
        <code>notFound(handler)</code> from <code>@nifrajs/core/not-found</code>. The handler returns a{" "}
        <code>Response</code>, or <code>undefined</code> to keep the default body.
      </p>
      <CodeBlock code={NOT_FOUND} />
      <ul>
        <li>
          <b>It answers a 404 and nothing else.</b> A path that exists under another method is still a{" "}
          <code>405</code> with <code>Allow</code>, a malformed path parameter is still a{" "}
          <code>400</code>, and a <code>404</code> a route or a mounted app returned itself is left
          alone.
        </li>
        <li>
          <b>The status stays honest.</b> A <code>2xx</code> answer is sent as a <code>404</code> with
          the body and headers you gave it, so a crawler or a cache never sees a missing page as a
          hit. A <code>3xx</code>, <code>4xx</code> or <code>5xx</code> answer is sent unchanged.
        </li>
        <li>
          <b>It sees the request line and headers, never the body.</b> The input is{" "}
          <code>method</code>, <code>url</code>, <code>pathname</code>, <code>headers</code>,{" "}
          <code>header(name)</code>, <code>signal</code> and <code>platform</code>.{" "}
          <code>pathname</code> is the path as it was sent, not percent-decoded: escape it before
          writing it into HTML, and never use it as a redirect target without checking it.
        </li>
        <li>
          <b>A fault is a plain 500.</b> A throw, a rejection, or a returned value that is not a{" "}
          <code>Response</code> is logged once and answered{" "}
          <code>{`{ "ok": false, "error": "internal_error" }`}</code> - the error's text never reaches
          the client. A thrown <code>Response</code> is an answer, as it is in a route.
        </li>
        <li>
          <b>It is bounded.</b> With <code>requestTimeoutMs</code> set, an async handler that outlives
          it has <code>signal</code> aborted and the request answered <code>503</code>. A deadline
          header on the request is not consulted for a request no route matched.
        </li>
        <li>
          <b>The answer takes the normal response path:</b> fixed response headers and{" "}
          <code>onResponse</code> hooks apply to it like any other response.
        </li>
      </ul>
      <p className="caveat">
        One handler per server: a second <code>notFound()</code> throws, as does one applied inside a{" "}
        <code>group()</code> (apply it to the parent) or after <code>listen()</code>.{" "}
        <code>merge()</code> does not carry a merged server's handler across. To <i>serve</i>{" "}
        unmatched paths - a single-page app's shell, or another app behind this one - register a
        wildcard route or a mount instead: those are matches, so they keep their own status, the
        request body, and the full route lifecycle.
      </p>

      <h2>Contract-first (defineContract + implement)</h2>
      <p>
        For larger apps - or when the contract is shared across services - declare it with{" "}
        <code>defineContract</code> (methods, paths, schemas; no handlers), then{" "}
        <code>implement</code> it. Handlers are checked against the contract, so a wrong path param,
        body, or return type is a compile error. The result is the same <code>app</code> the inline
        builder produces.
      </p>
      <CodeBlock code={CONTRACT} />

      <h2>The end-to-end-typed client</h2>
      <p>
        <code>@nifrajs/client</code> takes the server's type (<code>client&lt;typeof app&gt;</code>) and
        exposes a fluent, fully-typed proxy - no generated SDK. Path params are call arguments; the body
        and query are typed from the route's schema.
      </p>
      <CodeBlock code={CLIENT} />
      <p>
        A segment that is part literal, part param - <code>/files/:name.json</code>,{" "}
        <code>/post-:id</code>, <code>/v:major.:minor</code> - has no single param to name, so it is
        called with the segment as the request carries it: <code>{'api.files("report.json")'}</code>,{" "}
        <code>{'api("post-42")'}</code>, <code>{'api("v1.2")'}</code>. The argument is typed as the
        segment's literal text around any string, so <code>{'api.files("report.txt")'}</code> does
        not compile, and it is sent as one encoded segment: a <code>/</code> in it never adds a path
        level. <code>RequestPath</code> from <code>@nifrajs/core</code> is the same reading for a
        whole path: <code>{'RequestPath<"/files/:name.json">'}</code> is{" "}
        <code>{"`/files/${string}.json`"}</code>.
      </p>
      <p className="caveat">
        <b>Reserved proxy keys.</b> The client proxy resolves a fixed set of property names{" "}
        <i>before</i> path segments: the seven HTTP verbs{" "}
        (<code>get</code>/<code>post</code>/<code>put</code>/<code>patch</code>/<code>delete</code>/
        <code>head</code>/<code>options</code>, any casing) call the route, and{" "}
        <code>subscribe</code>, <code>ws</code>, <code>index</code>, and <code>then</code> (exact
        match) are the SSE, WebSocket, root-path, and thenable-guard keys. A route whose path
        contains a static segment spelling one of these - <code>.post("/api/delete", …)</code> -
        cannot be reached by <b>dot access</b>: <code>api.delete.post</code> resolves the{" "}
        <code>delete</code> verb, not the segment. The typed spelling is a <b>call on the parent
        node</b> - <code>api.api("delete").post()</code> sends <code>POST /api/delete</code> - the
        same call params use, accepting exactly the colliding segment names. The client type rejects
        the dot access at compile time with that guidance, and <code>nifra check</code> reports the
        collision (<code>NF-C018</code>, advisory). Prefer a verb-free segment
        (e.g. <code>/api/remove</code>) when you control the path; mark a route served only to
        non-typed-client consumers with <code>{"// nifra-expect reserved-segment"}</code> above its
        registration.
      </p>

      <h2>Results never throw</h2>
      <p>
        Every call resolves to a discriminated <code>Result</code>: branch on <code>ok</code> (or
        destructure <code>{"{ data, error }"}</code>). Success carries the typed <code>data</code>;
        failure carries a structured <code>ApiError</code> - a stable <code>error</code> code plus
        validation <code>issues</code> - and the HTTP <code>status</code>. No try/catch, no surprise
        exceptions on a 404 or 422.
      </p>
      <CodeBlock code={RESULT} />
      <p>
        A call that gets no HTTP answer has <code>status: 0</code> and one of four codes:{" "}
        <code>network_error</code>, <code>timeout</code>, <code>response_too_large</code>, or{" "}
        <code>invalid_path</code>. <code>invalid_path</code> means a param value was <code>.</code>{" "}
        or <code>..</code>: a URL reads those as steps to another path, in every encoding, so the
        client sends nothing rather than reach a route the call does not name.{" "}
        <code>.subscribe()</code> reports it through <code>onError</code> and closes;{" "}
        <code>.ws()</code> throws.
      </p>
      <p>
        The same client runs in the browser and on the server. During SSR, a route's{" "}
        <a href="/docs/data">loader</a> calls it <b>in-process</b> (no network hop) via{" "}
        <code>ctx.api</code>. Next: <a href="/docs/routing">file routing</a>,{" "}
        <a href="/docs/data">loaders &amp; actions</a>, and <a href="/docs/plugins">plugins</a>.
      </p>
    </div>
  )
}
