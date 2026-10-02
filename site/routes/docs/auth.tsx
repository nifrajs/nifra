import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/auth",
  "Nifra - Auth & sessions",
  "Turnkey auth with @nifrajs/better-auth (OAuth, magic links, 2FA), or signed-cookie + server-store sessions, route guards, and CSRF with @nifrajs/auth.",
)

const BETTERAUTH = `// doc-check: skip - needs the third-party \`better-auth\` package + your \`db\`; install it to run this.
// backend/auth.ts - your configured Better Auth instance (database, providers, …):
import { betterAuth as createBetterAuth } from "better-auth"
export const auth = createBetterAuth({ database: db, emailAndPassword: { enabled: true } })

// backend/app.ts - ONE use() mounts every Better Auth endpoint at /api/auth/*:
import { betterAuth, getSession, requireSession } from "@nifrajs/better-auth"
export const backend = server()
  .use(betterAuth(auth))                                       // sign-in/up/out, OAuth, 2FA, session…
  .get("/me", async (c) => (await requireSession(auth, c.req)).user)  // typed; 401 when signed out

// routes/account.backend.ts - a loader or action reads the session from the raw Request:
export const loaderOutput = t.object({ user: t.object({ id: t.string(), name: t.string() }) })
export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(auth, request)              // { user, session } | null - typed
  const { user } = await requireSession(auth, request, { redirectTo: "/login" })  // or guard it
  return { user }
}`

const AUTHJS = `// doc-check: skip - needs \`@auth/core\` providers + AUTH_SECRET; install them to run this.
// backend/auth.ts - your Auth.js config (any @auth/core provider: GitHub, Google, Credentials, …):
import { authjs, getSession, requireAuthUser } from "@nifrajs/authjs"
import GitHub from "@auth/core/providers/github"
export const authConfig = {
  providers: [GitHub({ clientId: process.env.GITHUB_ID! })],
  secret: process.env.AUTH_SECRET!,
  trustHost: true, // or authUrl behind a proxy
}

// backend/app.ts - ONE use() mounts every Auth.js endpoint at /api/auth/*:
export const backend = server()
  .use(authjs(authConfig))                                     // sign-in, OAuth callbacks, session…
  .get("/me", async (c) => ({ user: (await getSession(c.req, authConfig))?.user ?? null }))

// routes/account.backend.ts - guard it, or read it in a loader from the raw Request:
export const loaderOutput = t.object({ user: t.object({ name: t.string() }) })
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireAuthUser(request, authConfig, { redirectTo: "/login" })
  return { user }
}

// Frontend - any framework via the agnostic client, or React bindings:
// import { createAuthClient } from "@nifrajs/authjs/client"
// await createAuthClient().signIn("github")
// import { AuthSessionProvider, useAuthSession } from "@nifrajs/web-react/auth"`

const SETUP = `// backend/auth.ts - one session manager, created on first use so the secret is read at request time.
// Store mode keeps data server-side; cookie mode (no store) is stateless.
import { createSessions, MemorySessionStore } from "@nifrajs/auth"

let manager: ReturnType<typeof createSessions> | undefined
export const getSessions = () => (manager ??= createSessions({
  secret: process.env.SESSION_SECRET!,          // ≥ 16 chars; rotating it invalidates all sessions
  store: new MemorySessionStore(),              // prod: new KVSessionStore(env.SESSIONS)
  // cookie: { secure: false },                 // local http dev only
}))`

const LOGIN = `// backend/app.ts - login/logout are plain nifra routes (full Context → they can WRITE the cookie).
const sessions = getSessions()
app.use(csrf())                                          // Origin check on unsafe methods

app.post("/api/login", async (c) => {
  const { username } = Object.fromEntries(await c.req.formData())
  // ... verify the credential (Better Auth / Lucia / your own) ...
  const session = await sessions.get(c)
  session.set("userId", String(username))
  sessions.regenerate(session)                           // rotate the id on login (fixation defense)
  await sessions.commit(c, session)
  return redirect("/")                                   // the Set-Cookie rides the redirect
})

app.post("/api/logout", async (c) => {
  await sessions.destroy(c, await sessions.get(c))
  return redirect("/login")
})`

const GUARD = `// routes/account.backend.ts - a protected route's loader reads the session and redirects when absent.
import { requireUser } from "@nifrajs/auth"
import { t } from "@nifrajs/schema"
import { getSessions } from "../backend/auth"   // backend code: a backend half imports it directly
import type { Route } from "./+types/account"

export const loaderOutput = t.object({ userId: t.string() })
export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSessions().read(request)
  // requireUser throws a 302 to /login when there's no session, and the loader stops there.
  const userId = requireUser(session, "userId", { redirectTo: "/login" })
  return { userId }
}`

export default function Auth() {
  return (
    <div className="prose">
      <h1 className="page">Auth &amp; sessions</h1>
      <p className="lead">
        Three paths. <b><a href="#better-auth">@nifrajs/better-auth</a></b> is turnkey - mount{" "}
        <a href="https://better-auth.com">Better Auth</a> (OAuth, magic links, 2FA, …) into your app in
        one line. <b><a href="#authjs">@nifrajs/authjs</a></b> mounts{" "}
        <a href="https://authjs.dev">Auth.js</a> (OAuth/OIDC providers, credentials, WebAuthn-ready)
        the same way, with a framework-agnostic client plus React bindings.{" "}
        <b><a href="#sessions">@nifrajs/auth</a></b> is the framework half - <b>signed-cookie or
        server-store sessions</b>, <b>route guards</b>, and <b>CSRF</b> - when you want to own identity
        yourself. Nifra owns the <i>session</i>; you bring (or mount) the <i>who</i>.
      </p>

      <h2 id="better-auth">Full auth with Better Auth</h2>
      <p>
        <code>@nifrajs/better-auth</code> bridges <a href="https://better-auth.com">Better Auth</a> into
        nifra: <code>betterAuth(auth)</code> mounts its handler at <code>/api/auth/*</code> (GET + POST),
        so every endpoint - sign-in/up/out, OAuth callbacks, session, 2FA, magic links - is served by
        your Nifra server. Read the session with <code>getSession(auth, request)</code> (typed{" "}
        <code>{`{ user, session } | null`}</code>) or guard a route with{" "}
        <code>requireSession(auth, request, options?)</code> (returns it, or throws a 401/redirect{" "}
        <code>Response</code>). It's declared <b>structurally</b> - no hard dependency on Better Auth, so
        your tests need no database - and your Better Auth types flow through by inference.
      </p>
      <CodeBlock code={BETTERAUTH} />
      <p>
        Prefer to own identity (custom password/OAuth, Lucia, …)? Use the session primitives below.
      </p>

      <h2 id="authjs">Auth.js, mounted natively</h2>
      <p>
        <code>@nifrajs/authjs</code> is the official <a href="https://authjs.dev">Auth.js</a>{" "}
        integration: <code>authjs(config)</code> serves <code>/api/auth/*</code> (sign-in, OAuth
        callbacks, session, sign-out, CSRF) through <code>@auth/core</code> itself - PKCE, state,
        and token verification stay Auth.js's job, never a reimplementation. Read the session with{" "}
        <code>getSession(request, config)</code> (typed <code>Session | null</code>, works in
        handlers and loaders) or guard with <code>requireAuthUser(request, config)</code> (returns
        the user, or throws a 401/redirect). The frontend half is a framework-agnostic client
        (<code>createAuthClient()</code> - session, sign-in, sign-out) plus{" "}
        <code>&lt;AuthSessionProvider&gt;</code> / <code>useAuthSession()</code> in{" "}
        <code>@nifrajs/web-react/auth</code>.
      </p>
      <CodeBlock code={AUTHJS} />
      <p>
        Secrets resolve per request - explicit <code>secret</code>, then the <code>AUTH_SECRET</code>{" "}
        platform binding (edge-safe), then <code>process.env</code> - and a missing secret fails loud
        instead of signing with nothing. Behind a proxy, pass <code>authUrl</code> (or{" "}
        <code>trustHost</code>) so redirects and cookies use the public origin.
      </p>

      <h2 id="sessions">Set up a session manager</h2>
      <p>
        <code>createSessions</code> signs the cookie (HMAC, verified constant-time) and always marks it{" "}
        <code>HttpOnly</code>. In <b>store mode</b> the cookie is just an opaque id and the data lives in
        a <code>SessionStore</code>; in <b>cookie mode</b> (no store) the data is signed into the cookie.
        Stores mirror the ISR discipline: <code>MemorySessionStore</code> is prod-guarded;{" "}
        <code>KVSessionStore</code> is the durable, shared production store.
      </p>
      <CodeBlock code={SETUP} />

      <h2>Log in &amp; out</h2>
      <p>
        A loader can <i>read</i> the session but can't write cookies - so login/logout live in plain
        Nifra routes that have the full <code>Context</code>. <code>regenerate()</code> rotates the
        session id on login to defend against fixation; the <code>Set-Cookie</code> rides the redirect.
      </p>
      <CodeBlock code={LOGIN} />

      <h2>Guard a route</h2>
      <p>
        <code>requireSession</code> / <code>requireUser</code> throw a <code>status(...)</code> render
        (a 302 to <code>redirectTo</code>, or a 401) when the session is missing - Nifra renders a
        thrown control-flow value as-is, so the guard short-circuits the loader. It is plain data, not
        a <code>Response</code>: same bytes on the wire, on the lane an ordinary return takes. To guard
        every page under a directory, run the same check in the <code>middleware</code> export of that
        directory's <code>_layout.backend.ts</code> - see <a href="/docs/routing#middleware">Route middleware</a>.
      </p>
      <CodeBlock code={GUARD} />

      <h2 id="server-only">Session code stays in the backend</h2>
      <p>
        The session manager, an auth instance and their secrets live in <code>backend/</code>, and only
        backend code imports them: a route's <code>.backend.ts</code> half, <code>backend/app.ts</code>.
        A page or a <code>frontend/</code> component that imported <code>backend/auth.ts</code> fails
        the build with the import chain that reached it, so a secret cannot ride into the browser
        bundle. A page that needs the user reads it from its loader data, which{" "}
        <code>loaderOutput</code> narrows to the fields it declares - see{" "}
        <a href="/docs/structure">Project structure</a>.
      </p>

      <h2>CSRF</h2>
      <p>
        <code>{"app.use(csrf({ origins }))"}</code> rejects any unsafe-method request whose{" "}
        <code>Origin</code>/<code>Referer</code> doesn't match an allowed origin - the recommended
        defense for cookie-auth. Pair it with the rate-limit middleware on your login route.
      </p>

      <h2>Cookie Security Defaults</h2>
      <p>
        Nifra's <code>c.set.cookie()</code> applies secure defaults to every cookie:
      </p>
      <ul>
        <li>
          <b>HttpOnly</b> - not accessible to JavaScript (prevents XSS theft)
        </li>
        <li>
          <b>Secure</b> - sent only over HTTPS (set <code>{"{ secure: false }"}</code> for local http dev)
        </li>
        <li>
          <b>SameSite=Lax</b> - mitigates CSRF without blocking top-level navigation
        </li>
        <li>
          <b>Path=/</b> - sent on all requests (override with <code>{"{ path: '/admin' }"}</code> if needed)
        </li>
      </ul>
      <p>
        These are applied to <b>all</b> cookies (sessions, CSRF tokens, preferences) unless explicitly
        overridden. When developing locally, you <b>must</b> set <code>{"{ secure: false }"}</code> or
        the cookie will be rejected by the browser on non-HTTPS connections.
      </p>

      <h2>Rate Limiting on Login</h2>
      <p>
        The rate-limit middleware (<code>@nifrajs/middleware</code>) protects against brute-force by enforcing
        per-caller buckets keyed by <code>c.clientIp</code> - the socket peer by default. <b>Critical:</b> if
        your app is behind a reverse proxy (CDN, load balancer), declare it with the server's{" "}
        <code>clientIp</code> option so the caller is read from the forwarding chain instead of the proxy's
        own address (which would put all users in one bucket). Never key on a raw{" "}
        <code>X-Forwarded-For</code> value: a client writes whatever it likes there and gets a fresh bucket
        per request.
      </p>
      <CodeBlock
        code={`import { server } from "@nifrajs/core/server"
import { MemoryStore, rateLimit } from "@nifrajs/middleware"

// One reverse proxy you operate appends the caller to X-Forwarded-For. Behind a CDN that overwrites
// a single header instead, declare { header: "<that header>" }.
const app = server({ clientIp: { trustedHops: 1 } })
  .use(
    rateLimit({
      store: new MemoryStore(), // use a shared store (Redis, etc.) in production
      max: 5, // 5 attempts
      windowMs: 15 * 60 * 1000, // per 15 minutes
    }),
  )
  .post("/login", …)`}
        lang="ts"
      />
      <p>
        Declare only hops you actually run: a directly reachable app with <code>trustedHops</code> set lets
        a client forge the forwarded address. Check your proxy's documentation for the header it sets
        (Cloudflare sets <code>cf-connecting-ip</code>; AWS ALB appends to <code>x-forwarded-for</code>).
      </p>
    </div>
  )
}
