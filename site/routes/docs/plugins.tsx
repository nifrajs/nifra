import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page - no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra - Plugins & middleware",
  "Extend Nifra with definePlugin (typed context, idempotent) + hook-bundle middleware. Official middleware: requestId, logger, etag, bearer, apiKey, basicAuth, jwt/jwks, csrf, ipRestriction, bodyLimit, cors, securityHeaders, rateLimit, compression, cacheControl, cache, prettyJson, timing, methodOverride, trailingSlash, language, poweredBy, combine, openapi, healthcheck, idempotency.",
  "/docs/plugins",
)

const PLUGIN = `// doc-check: skip - fragment: the outer \`app\`, \`verify\`, and \`db\` are your application's.
import { definePlugin } from "@nifrajs/core/server"

// A plugin is just (app) => app - call use/derive/decorate or register routes.
// definePlugin adds a name so applying it twice (even transitively) is a no-op.
export const auth = definePlugin("auth", (app) =>
  app.derive((c) => ({ user: verify(c.req) })),  // adds c.user…
)

app
  .use(auth)                                       // …threaded to every handler after this:
  .get("/me", (c) => ({ id: c.user.id }))          // c.user is fully typed

// Inline plugins thread context too - no definePlugin needed for one-offs:
app.use((a) => a.decorate("db", db).derive((c) => ({ now: Date.now() })))`

const MIDDLEWARE = `import { server } from "@nifrajs/core/server"
import { cors, rateLimit, securityHeaders, MemoryStore } from "@nifrajs/middleware"

// Hardening middleware is a hook bundle (context-agnostic) - same app.use():
const app = server()
  .use(securityHeaders())
  .use(cors({ origin: ["https://app.example"] }))
  // MemoryStore is dev/single-instance only - use a shared store (Redis, etc.) in production.
  .use(rateLimit({ store: new MemoryStore(), max: 100, windowMs: 60_000 }))`

const PORTABLE_HOOK = `import type { Middleware } from "@nifrajs/core/server"

// ONE implementation, fast on every runtime: on Bun/Deno it mutates the
// response's own Headers in place; on Node it writes the outcome record on the
// direct socket writer - no Web Request/Response is ever built for it.
export function serverName(value: string): Middleware {
  return {
    onResponseHeaders(headers, req, status) {
      if (status < 500) headers.set("server", value)
    },
  }
}`

const STATIC_HEADERS = `// doc-check: skip - fragment: \`app\` is your application's server instance.
// No hook is registered, so a bare route still takes Bun's fused native lane.
app.responseHeaders({
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
})`

const OFFICIAL = `import { server } from "@nifrajs/core/server"
import { requestId, logger, etag } from "@nifrajs/middleware"

const app = server()
  .use(requestId())   // reuse/generate x-request-id → c.requestId (typed) + response header
  .use(logger())      // one structured line/request: { method, path, status, ms }
  .use(etag())        // content-hash ETag on GET 200s → 304 on matching If-None-Match`

const AUTHN = `// doc-check: skip - fragment: \`app\`, \`lookupUser\`, and the \`db\` lookup are your application's.
import { bearer, apiKey } from "@nifrajs/middleware"

// Bearer tokens - verify returns your principal (its type is inferred), 401s missing/invalid:
const auth = bearer({ verify: (token) => lookupUser(token) })   // AuthPlugin<User>
app
  .use(auth)                                                    // guards routes defined after it
  .get("/me", (c) => auth.requirePrincipal(c.req))              // typed principal, or throws 401

// API keys via a header (default x-api-key) - a fixed set compared in CONSTANT TIME…
app.use(apiKey({ keys: [process.env.API_KEY!] }))              // matched key becomes the principal
// …or custom (DB-backed) verification; 'optional' lets unauthenticated requests through:
app.use(apiKey({ verify: (key) => db.apiKeys.find(key), optional: true }))`

const PERF = `import { server } from "@nifrajs/core/server"
import { compression, cacheControl } from "@nifrajs/middleware"

const app = server()
  .use(compression())                                  // gzip compressible responses (Accept-Encoding)
  .use(cacheControl("public, max-age=60"))             // Cache-Control on GET/HEAD 2xx (won't clobber)
  // …or a per-path policy - return undefined to leave a response untouched:
  .use(cacheControl((req) =>
    new URL(req.url).pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : undefined))`

const OPS = `// doc-check: skip - fragment: \`app\`, \`db\`, and \`redis\` are your application's clients.
import { healthcheck, openapi } from "@nifrajs/middleware"

app
  // Liveness + readiness. /ready runs each check concurrently → 200 (all pass) or 503.
  .use(healthcheck({ checks: { db: () => db.ping(), cache: () => redis.ping() } }))
  // GET /openapi.json from your routes (paths, methods, params); ui adds a Scalar page at /reference.
  .use(openapi({ info: { title: "My API", version: "1.0.0" }, ui: true }))`

const RELIABILITY = `import { server } from "@nifrajs/core/server"
import { idempotency, MemoryIdempotencyStore } from "@nifrajs/middleware"

// A retried POST with the same Idempotency-Key replays the first response instead of
// re-running the side effect. Shared store in production (atomic claim); dev-only memory store.
const app = server()
app.use(idempotency({ store: new MemoryIdempotencyStore() }))`

const JWT_BASIC = `import { server } from "@nifrajs/core/server"
import { jwt, jwks, basicAuth } from "@nifrajs/middleware"

// JWT (WebCrypto): an explicit algorithm allowlist is REQUIRED; alg:none and RSA/HMAC confusion are rejected.
const auth = jwt({ key: process.env.JWT_SECRET!, algorithms: ["HS256"], issuer: "my-app" })
const app = server()
  .use(auth)                                       // 401s missing/invalid (optional:true lets them through)
  .get("/me", (c) => auth.requireClaims(c.req))    // typed claims, or throws 401; auth.claims(req) is nullable
// Asymmetric (rotating keys): key: jwks({ url: "https://issuer/.well-known/jwks.json" }) - https-only, cached.

// HTTP Basic - static creds compared in CONSTANT TIME (SHA-256 + timing-safe), or a verify callback.
app.use(basicAuth({ username: "admin", password: process.env.PASS!, realm: "staging" }))`

const CACHING = `import { server } from "@nifrajs/core/server"
import { cache, MemoryResponseCache, prettyJson } from "@nifrajs/middleware"

// Full response cache: pluggable store, Vary-aware keys, byte cap. Bypasses Set-Cookie and respects
// Cache-Control (no-store/private). MemoryResponseCache is per-instance - refuses prod unless opted in.
const app = server()
app.use(cache({ store: new MemoryResponseCache(), ttlMs: 30_000, vary: ["accept-language"] }))
app.use(prettyJson())   // pretty-print JSON responses (size-capped; optional ?pretty query toggle)`

const SHAPING = `import { server } from "@nifrajs/core/server"
import { methodOverride, trimTrailingSlash, language, timing, poweredBy, combine } from "@nifrajs/middleware"

const app = server()
  .use(methodOverride())     // POST + X-HTTP-Method-Override → PUT/PATCH/DELETE (a real pre-routing request rewrite)
  .use(trimTrailingSlash())  // canonicalize URLs: 308 redirect (or rewrite), same-origin only, conservative methods
  .use(language({ supported: ["en", "fr"], defaultLanguage: "en" }))  // Accept-Language → c.language + Content-Language
  .use(timing())             // Server-Timing header + typed c.timing marks/measures
// poweredBy() is opt-in (Nifra emits no X-Powered-By by default). combine(a, b, c) bundles several into one plugin.`

const REPORT = `// @nifrajs/web: observe loader/action failures for error reporting (Sentry-style).
createWebApp({
  adapter, manifest, clientEntry,
  onLoaderError: (error, { route, request }) => report(error, { route }),
})
// Fires before the nearest _error boundary renders - so errors the boundary
// would hide still reach your reporter. (Control-flow redirects aren't reported.)`

const IDENTITY = `import { defineRouterPlugin, server } from "@nifrajs/core/server"

// A plugin that mounts routes/hooks but adds NO context type: defineRouterPlugin (the clearer name for
// defineIdentityPlugin) keeps app.use()'s return type EXACTLY the caller's server, so routes added after
// .use() stay typed - and the typed client derived from them stays intact.
export const scim = defineRouterPlugin("scim", (app) => {
  app.get("/scim/v2/Users", () => ({ Resources: [] })) // mount as a SIDE EFFECT (a runtime-only route)
  return app                                           // return the app unchanged → caller's registry preserved
})

// /a AND /b stay fully typed across the .use():
const api = server().get("/a", () => ({ a: 1 })).use(scim).get("/b", () => ({ b: 2 }))`

export default function Plugins() {
  return (
    <div className="prose">
      <h1 className="page">Plugins &amp; middleware</h1>
      <p className="lead">
        Nifra's plugin surface lives in the agnostic core, so it's the same on every runtime and
        framework. A plugin is a function over the app; middleware is a bundle of lifecycle hooks.
        Both apply with <code>app.use()</code>.
      </p>

      <h2>The plugin convention</h2>
      <p>
        A <b>plugin</b> is <code>{`(app) => app`}</code> - it calls <code>use</code>/<code>derive</code>/
        <code>decorate</code> or registers routes, and returns the app. Because <code>derive</code> and{" "}
        <code>decorate</code> are type-threaded, any context a plugin adds is <b>typed on every handler
        defined after</b> <code>app.use(plugin)</code> - no extra generics. Wrap a plugin with{" "}
        <code>definePlugin(name, …)</code> to make it <b>idempotent</b>: applied twice (e.g. because two
        plugins both depend on it), it wires its hooks once.
      </p>
      <CodeBlock code={PLUGIN} />

      <h2>Route/hook plugins: keep types with defineRouterPlugin</h2>
      <p>
        A plugin that registers routes or hooks but adds <b>no context type</b> - e.g. mounting an auth
        router - should be built with <code>defineRouterPlugin</code> (the clearer-named alias of{" "}
        <code>defineIdentityPlugin</code>), not <code>definePlugin</code>. It threads the app's{" "}
        <i>exact</i> type through <code>use</code>, so the route registry (and the typed client derived
        from it) survives the plugin. Mount routes as a <b>side effect</b> then <code>return app</code>{" "}
        (registering with <code>.get</code>/<code>.post</code> directly would change the type away from the
        identity, so those routes run but aren't in the typed registry - the trade that keeps everything
        else typed).
      </p>
      <p className="caveat">
        <b>Footgun:</b> reach for <code>definePlugin</code> here instead and a plain{" "}
        <code>{`definePlugin((app) => app.get(...))`}</code> infers <code>app</code> as{" "}
        <code>{`Server<any, any>`}</code>, collapsing <code>use()</code>'s result - and your whole typed
        client - to <code>any</code>, with <b>no type error and no runtime error</b>.{" "}
        <code>@nifrajs/better-auth</code> is built with the identity form, so{" "}
        <code>{`server().use(betterAuth(auth)).get(...)`}</code> keeps every route typed.
      </p>
      <CodeBlock code={IDENTITY} />

      <h2>Lifecycle hooks</h2>
      <p>
        Plugins can attach five lifecycle hooks: <code>onRequest</code> (pre-routing, can
        short-circuit), <code>beforeHandle</code>/<code>afterHandle</code> (around the handler),
        <code>onError</code>, and <code>onResponse</code> (transform every response - success,
        error, 404). Hardening middleware uses the same hook model:
      </p>
      <CodeBlock code={MIDDLEWARE} />

      <h2>Header middleware: one portable hook, fast everywhere</h2>
      <p>
        Most response middleware only reads or writes <b>headers</b> - security headers, CORS
        reflection, cache directives, negotiation. For that shape, prefer{" "}
        <code>onResponseHeaders</code> over <code>onResponse</code>: it receives a mutable
        case-insensitive header view, a minimal request view (<code>{`{ method, url, header(name) }`}</code>),
        and the status. One implementation runs on every runtime - on Bun/Deno inside the normal
        response walk against the response's own <code>Headers</code> (in place, no clone), and on
        Node against the outcome's plain header record on the <b>direct socket writer</b>, without
        ever materializing Web <code>Request</code>/<code>Response</code> objects:
      </p>
      <CodeBlock code={PORTABLE_HOOK} />
      <p>
        Why this matters on Node: a full <code>onResponse(res: Response)</code> hook needs real Web
        objects, and building them costs several microseconds per request - registering even one
        drops a realistic Node app from ~95% to ~70% of a raw <code>node:http</code> server's
        throughput (it was worse before the lazy bridge below). <code>onResponseHeaders</code> never
        pays that: the built-ins that use it (<code>cors</code>, static <code>cacheControl</code>,{" "}
        <code>language</code>) keep the direct writer at full speed.
      </p>

      <h2>Fixed headers: declare them, don't hook them</h2>
      <p>
        Some response headers have no per-request decision behind them at all - a frame policy, a
        referrer policy, an HSTS directive. Declaring those with{" "}
        <code>app.responseHeaders(record)</code> registers <b>no hook</b>: the values are folded into
        response construction (one prebuilt init for JSON renders, one record merge when the route
        set its own headers), so the app keeps the lanes a hook would close - Bun's fused native
        routes, and the Node direct writer for a full <code>onResponse</code>. They still apply to
        every response a hook would cover: success, error, 404/405, timeout, short-circuit.
      </p>
      <CodeBlock code={STATIC_HEADERS} />
      <p>
        Declared headers are <b>defaults</b>: a value the request itself produced -{" "}
        <code>c.set.headers</code>, or a response hook - wins, whatever casing it used. Names are
        lowercased once at wire-up, and a name the render owns (<code>content-type</code>,{" "}
        <code>content-length</code>, <code>transfer-encoding</code>, <code>set-cookie</code>), an
        invalid name, or a non-string value throws immediately. Declare them before your response
        hooks: a declaration made after one cannot precede it, so it degrades to an ordinary{" "}
        <code>onResponseHeaders</code> hook to keep registration order honest.
      </p>
      <p>
        <code>securityHeaders()</code> and the default <code>poweredBy()</code> ship this way -{" "}
        <b>measured +11% on a bare Bun GET</b> against the same headers written by a hook, byte-identical
        on the wire (pinned by parity suites on Bun, Node, and Deno). A route whose headers depend on
        the request keeps <code>onResponseHeaders</code>: that is why <code>cors</code> (origin
        reflection) and conditional <code>cacheControl</code> are still hooks.
      </p>
      <ul>
        <li>
          <b>Body middleware gets its own portable tier: <code>onResponseBody</code>.</b> It
          receives the FINAL framework-serialized bytes (plus the same header view and status) and
          may return replacement bytes - on every runtime the bytes are already resident before any
          Web <code>Response</code> exists, so nothing is drained. A body-hashing middleware
          benchmarks at ~92% of a raw <code>node:http</code> server this way - Fastify-class - vs
          ~50% through the full <code>onResponse</code> contract. Handler-returned raw{" "}
          <code>Response</code>s (proxied fetch, SSE, streamed SSR) are skipped by contract.
        </li>
        <li>
          <b>The full <code>onResponse(res: Response)</code> stays for what only it can do:</b>{" "}
          wrapping streams, capturing complete responses (caching, idempotency replay), and
          intercepting raw <code>Response</code>s uniformly. On Node such a response is bridged
          through a lazy spec-shaped Response that materializes headers and body machinery only when
          the hook actually touches them - powerful, and priced accordingly.
        </li>
        <li>
          <b>Advanced - native twins:</b> a middleware that needs per-request state or a native
          preflight short-circuit can pair its Web hooks with{" "}
          <code>onNodeRequest</code>/<code>onNodeResponse</code> twins (that is how{" "}
          <code>rateLimit</code> and <code>logger</code> stay native: the same context object reaches
          both twins, so a <code>WeakMap</code> keyed on it carries state across the request). Twins
          are all-or-nothing per app on Node and must stay semantically identical to their Web
          hooks; <code>onResponseHeaders</code> needs none of this.
        </li>
        <li>
          <code>timing</code> stays Web-only for now (its <code>c.timing</code> metric channel
          crosses the handler lifecycle).
        </li>
      </ul>

      <h2>Official plugins</h2>
      <p>
        <code>@nifrajs/middleware</code> seeds a few <code>definePlugin</code> plugins to build on:
      </p>
      <CodeBlock code={OFFICIAL} />
      <ul>
        <li>
          <code>requestId()</code> - reuses an inbound <code>x-request-id</code> or generates one,
          threads it as <code>c.requestId</code>, and echoes the header.
        </li>
        <li>
          <code>logger()</code> - one structured line per request (method, path, status, duration);
          covers 404s and errors; route it to your own sink via <code>log</code>.
        </li>
        <li>
          <code>etag()</code> - adds a content-hash <code>ETag</code> to <code>GET</code> <code>200</code>s
          and returns <code>304</code> on a matching <code>If-None-Match</code>.
        </li>
      </ul>

      <h2>Authentication</h2>
      <p>
        <code>bearer</code> and <code>apiKey</code> guard the routes defined after them and expose a{" "}
        <b>fully typed</b> principal. Because the derive path can't carry a precise type through a named
        plugin, the principal is read from the <b>returned instance</b> - <code>auth.principal(req)</code>{" "}
        (nullable) or <code>auth.requirePrincipal(req)</code> (throws <code>401</code>) - mirroring{" "}
        <code>@nifrajs/auth</code> and <code>@nifrajs/better-auth</code>. It's verified once per request and
        cached. For full session-based auth (OAuth, magic links, 2FA), see{" "}
        <a href="/docs/auth">Auth &amp; sessions</a>.
      </p>
      <CodeBlock code={AUTHN} />
      <ul>
        <li>
          <code>bearer({`{ verify }`})</code> - parses <code>Authorization: Bearer</code>, rejects with{" "}
          <code>401</code> + <code>WWW-Authenticate</code> unless <code>optional</code>.
        </li>
        <li>
          <code>apiKey({`{ keys }`})</code> - a fixed key set compared in <b>constant time</b> (SHA-256 +
          early-exit-free byte compare; the matched key is the principal). <code>apiKey({`{ verify }`})</code>{" "}
          does custom, typed verification.
        </li>
      </ul>

      <h2>Performance</h2>
      <p>
        <code>compression()</code> gzips compressible responses (via the Web-standard{" "}
        <code>CompressionStream</code>, so it works on every runtime) when the client sends{" "}
        <code>Accept-Encoding: gzip</code>, peeking the body so tiny responses aren't enlarged.{" "}
        <code>cacheControl()</code> sets <code>Cache-Control</code> on matching responses without
        clobbering one a handler already set.
      </p>
      <p>
        <b>Security note (BREACH):</b> any HTTP compression makes the response size depend on its
        content, so a response that mixes a secret with attacker-reflected request input can leak
        the secret through the compressed length. Nifra's CSRF tokens are HMAC-signed per session
        and safe to compress, but if a route reflects request input alongside a per-request secret,
        exclude it via the <code>compressible</code> option or route scoping.
      </p>
      <CodeBlock code={PERF} />

      <h2>Operations &amp; docs</h2>
      <p>
        <code>healthcheck()</code> adds liveness (<code>/health</code>) and readiness (<code>/ready</code>)
        endpoints - apply it <b>before</b> any auth guard so they stay public. <code>openapi()</code>{" "}
        serves an OpenAPI 3.1 document at <code>/openapi.json</code>, generated from your routes - add{" "}
        <code>ui: true</code> for a Scalar API-reference page at <code>/reference</code>. Paths,
        methods, and params are introspected; <code>servers</code>, <code>tags</code>,{" "}
        <code>security</code>, and <code>securitySchemes</code> are document options, and{" "}
        <code>operations</code> (keyed by <code>"GET /users/:id"</code>) supplies per-route bodies/security
        that Standard Schema can't expose. For full request/response <i>schemas</i>, generate from a{" "}
        <code>defineContract</code> with <code>@nifrajs/schema</code>'s <code>toOpenAPI</code> (it reads the{" "}
        <code>t</code> JSON Schema and emits <code>$ref</code> reuse). <code>buildOpenApiDocument</code> is
        exported for build-time generation too.
      </p>
      <CodeBlock code={OPS} />

      <h2>Reliability</h2>
      <p>
        <code>idempotency()</code> makes a retried unsafe request (same <code>Idempotency-Key</code> header)
        replay the first response instead of re-running the side effect - no double-charge on a dropped
        connection. It short-circuits before the handler; a concurrent retry gets a <code>409</code>. See{" "}
        <a href="/docs/security">Security &amp; hardening</a> for the store contract, the production
        guidance (shared store + DB constraint), and the <code>Set-Cookie</code> rule.
      </p>
      <CodeBlock code={RELIABILITY} />

      <h2>JWT &amp; Basic auth</h2>
      <p>
        <code>jwt</code> verifies tokens with WebCrypto. The <code>algorithms</code> allowlist is{" "}
        <b>required</b>; <code>alg:none</code> and RSA/HMAC confusion are rejected, <code>exp</code> is
        enforced by default, and claims (<code>iss</code>/<code>aud</code>/<code>nbf</code>) are checked.
        Read the typed claims off the returned plugin - <code>auth.requireClaims(c.req)</code> (throws{" "}
        <code>401</code>) or <code>auth.claims(c.req)</code> (nullable). For rotating keys, pass{" "}
        <code>key: jwks({`{ url }`})</code> (HTTPS-only, cached, size/time-bounded). <code>basicAuth</code>{" "}
        compares static credentials in <b>constant time</b> (or takes a <code>verify</code> callback).
      </p>
      <CodeBlock code={JWT_BASIC} />

      <h2>Response caching</h2>
      <p>
        <code>cache</code> is a full response cache with a pluggable store, <code>Vary</code>-aware keys,
        and a byte cap. It <b>bypasses <code>Set-Cookie</code></b> and honors request/response{" "}
        <code>Cache-Control</code> (<code>no-store</code>/<code>private</code>) so it never serves one
        user's response to another. <code>MemoryResponseCache</code> is per-instance and refuses{" "}
        <code>NODE_ENV=production</code> unless opted in - use a shared store in prod. <code>prettyJson</code>{" "}
        pretty-prints JSON responses (capped, with an optional query toggle).
      </p>
      <CodeBlock code={CACHING} />

      <h2>Request shaping &amp; negotiation</h2>
      <p>
        These build on the <code>onRequest</code> hook's ability to return a replacement{" "}
        <code>Request</code> (a real pre-routing rewrite, so handlers/validation/response hooks all see
        the rewritten request). <code>methodOverride</code> tunnels <code>PUT</code>/<code>PATCH</code>/
        <code>DELETE</code> through a <code>POST</code> header (query tunneling is off by default);{" "}
        <code>trimTrailingSlash</code>/<code>appendTrailingSlash</code> canonicalize URLs (same-origin,
        no open redirect); <code>language</code> negotiates <code>Accept-Language</code> into{" "}
        <code>c.language</code>; <code>timing</code> emits <code>Server-Timing</code>; <code>poweredBy</code>{" "}
        is opt-in; <code>combine</code> bundles several middleware into one.
      </p>
      <CodeBlock code={SHAPING} />

      <h2>Security middleware</h2>
      <p>
        The security set - <code>csrf</code> (signed double-submit + Origin/Referer), <code>jwt</code>,{" "}
        <code>ipRestriction</code> (IPv4/IPv6 + CIDR, fails closed), and <code>bodyLimit</code>{" "}
        (Content-Length cap before routing) - is documented with hardening guidance on{" "}
        <a href="/docs/security">Security &amp; hardening</a>. All comparisons are constant-time and all
        defaults fail closed.
      </p>

      <h2>Error reporting</h2>
      <p>
        For SSR apps, <code>createWebApp</code>'s <code>onLoaderError</code> lets a reporting plugin
        observe every loader/action failure - including ones a nearest <code>_error</code> boundary
        would otherwise hide.
      </p>
      <CodeBlock code={REPORT} />
    </div>
  )
}
