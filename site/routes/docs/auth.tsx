import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Auth & sessions",
  "Turnkey auth with @nifrajs/better-auth (OAuth, magic links, 2FA), or signed-cookie + server-store sessions, route guards, and CSRF with @nifrajs/auth.",
)

const BETTERAUTH = `// doc-check: skip — needs the third-party \`better-auth\` package + your \`db\`; install it to run this.
// auth.ts — your configured Better Auth instance (database, providers, …):
import { betterAuth as createBetterAuth } from "better-auth"
export const auth = createBetterAuth({ database: db, emailAndPassword: { enabled: true } })

// server.ts — ONE use() mounts every Better Auth endpoint at /api/auth/*:
import { betterAuth, getSession, requireSession } from "@nifrajs/better-auth"
const app = server()
  .use(betterAuth(auth))                                       // sign-in/up/out, OAuth, 2FA, session…
  .get("/me", async (c) => (await requireSession(auth, c.req)).user)  // typed; 401 when signed out

// In a loader/action, read the session from the raw Request:
export async function loader({ request }) {
  const session = await getSession(auth, request)              // { user, session } | null — typed
  const { user } = await requireSession(auth, request, { redirectTo: "/login" })  // or guard it
  return { user }
}`

const SETUP = `// auth.ts — one session manager. LAZY so a route module can import it without shipping it to the
// browser (see the warning below). Store mode keeps data server-side; cookie mode (no store) is stateless.
import { createSessions, MemorySessionStore } from "@nifrajs/auth"

let manager: ReturnType<typeof createSessions> | undefined
export const getSessions = () => (manager ??= createSessions({
  secret: process.env.SESSION_SECRET!,          // ≥ 16 chars; rotating it invalidates all sessions
  store: new MemorySessionStore(),              // prod: new KVSessionStore(env.SESSIONS)
  // cookie: { secure: false },                 // local http dev only
}))`

const LOGIN = `// server.ts — login/logout are plain nifra routes (full Context → they can WRITE the cookie).
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
})

createWebApp({ /* … */ api: sessions })                  // inject the manager into loaders as ctx.api`

const GUARD = `// doc-check: skip — fragment: \`api\` is the session manager createWebApp injected (see setup above).
// A protected route's loader — reads the session and redirects when absent.
import { requireUser } from "@nifrajs/auth"   // browser-safe; OK to import in a route module

export async function loader({ request, api }) {
  const sessions = api                       // the manager injected via createWebApp's \`api\`
  const session = await sessions.read(request)
  // requireUser throws a 302 to /login when there's no session; nifra returns the thrown Response.
  const userId = requireUser(session, "userId", { redirectTo: "/login" })
  return { userId }
}`

export default function Auth() {
  return (
    <div className="prose">
      <h1 className="page">Auth &amp; sessions</h1>
      <p className="lead">
        Two paths. <b><a href="#better-auth">@nifrajs/better-auth</a></b> is turnkey — mount{" "}
        <a href="https://better-auth.com">Better Auth</a> (OAuth, magic links, 2FA, …) into your app in
        one line. <b><a href="#sessions">@nifrajs/auth</a></b> is the framework half — <b>signed-cookie or
        server-store sessions</b>, <b>route guards</b>, and <b>CSRF</b> — when you want to own identity
        yourself. Nifra owns the <i>session</i>; you bring (or mount) the <i>who</i>.
      </p>

      <h2 id="better-auth">Full auth with Better Auth</h2>
      <p>
        <code>@nifrajs/better-auth</code> bridges <a href="https://better-auth.com">Better Auth</a> into
        nifra: <code>betterAuth(auth)</code> mounts its handler at <code>/api/auth/*</code> (GET + POST),
        so every endpoint — sign-in/up/out, OAuth callbacks, session, 2FA, magic links — is served by
        your nifra server. Read the session with <code>getSession(auth, request)</code> (typed{" "}
        <code>{`{ user, session } | null`}</code>) or guard a route with{" "}
        <code>requireSession(auth, request, options?)</code> (returns it, or throws a 401/redirect{" "}
        <code>Response</code>). It's declared <b>structurally</b> — no hard dependency on Better Auth, so
        your tests need no database — and your Better Auth types flow through by inference.
      </p>
      <CodeBlock code={BETTERAUTH} />
      <p>
        Prefer to own identity (custom password/OAuth, Lucia, …)? Use the session primitives below.
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
        A loader can <i>read</i> the session but can't write cookies — so login/logout live in plain
        Nifra routes that have the full <code>Context</code>. <code>regenerate()</code> rotates the
        session id on login to defend against fixation; the <code>Set-Cookie</code> rides the redirect.
      </p>
      <CodeBlock code={LOGIN} />

      <h2>Guard a route</h2>
      <p>
        <code>requireSession</code> / <code>requireUser</code> throw a <code>Response</code> (a 302 to{" "}
        <code>redirectTo</code>, or a 401) when the session is missing — nifra returns a thrown Response
        as-is, so the guard short-circuits the loader.
      </p>
      <CodeBlock code={GUARD} />

      <h2 id="server-only">⚠️ Never import server-only code into a route module</h2>
      <p>
        A route's <code>loader</code> runs only on the server, but its module is <b>also bundled for the
        browser</b> (for the component) — and the loader is <b>not</b> stripped from that bundle. So a
        top-level <code>import</code> of the session manager (or a DB client, or anything touching{" "}
        <code>process.env</code>) would ship server code to the client and crash hydration. Reach server
        resources through <code>ctx.api</code> / <code>ctx.env</code> instead (inject them via{" "}
        <code>createWebApp</code>) — exactly how the manager is passed as <code>api</code> above.{" "}
        <code>requireUser</code> is fine to import: it only builds a <code>Response</code>, no secrets.
      </p>

      <h2>CSRF</h2>
      <p>
        <code>{"app.use(csrf({ origins }))"}</code> rejects any unsafe-method request whose{" "}
        <code>Origin</code>/<code>Referer</code> doesn't match an allowed origin — the recommended
        defense for cookie-auth. Pair it with the rate-limit middleware on your login route.
      </p>

      <h2>Cookie Security Defaults</h2>
      <p>
        Nifra's <code>c.set.cookie()</code> applies secure defaults to every cookie:
      </p>
      <ul>
        <li>
          <b>HttpOnly</b> — not accessible to JavaScript (prevents XSS theft)
        </li>
        <li>
          <b>Secure</b> — sent only over HTTPS (set <code>{"{ secure: false }"}</code> for local http dev)
        </li>
        <li>
          <b>SameSite=Lax</b> — mitigates CSRF without blocking top-level navigation
        </li>
        <li>
          <b>Path=/</b> — sent on all requests (override with <code>{"{ path: '/admin' }"}</code> if needed)
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
        IP-based buckets. <b>Critical:</b> if your app is behind a reverse proxy (CDN, load balancer), you{" "}
        <b>must</b> configure <code>trustedProxies</code> so the middleware reads the real client IP from{" "}
        <code>X-Forwarded-For</code> instead of the proxy's IP (which would cause all users to share a rate
        limit):
      </p>
      <CodeBlock
        code={`app.use(
  rateLimit({
    key: (c) => "login:" + c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? c.ip,
    limit: 5,      // 5 attempts
    window: 15 * 60 * 1000,  // per 15 minutes
    onExceeded: (c) => new Response("Too many login attempts", { status: 429 }),
  }),
)
.post("/login", …)`}
        lang="ts"
      />
      <p>
        Without <code>trustedProxies</code> configured correctly, the middleware will fall back to the
        proxy's IP address, and your entire user base will share a single rate-limit bucket — defeating
        the protection. Check your proxy's documentation for how it sets{" "}
        <code>X-Forwarded-For</code> (Cloudflare uses <code>cf-connecting-ip</code>, AWS ALB/NLB use{" "}
        <code>x-forwarded-for</code>).
      </p>
    </div>
  )
}
