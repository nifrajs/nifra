/**
 * A sign-in, a sign-out or a switch to another account rotates the identity epoch, so every tab drops
 * the pages it kept for the previous visitor; anything else the same visitor does keeps it, or every
 * renewal would reload every open page. A write to other session data keeps it once the app names
 * the keys that say who its visitor is, and rotates it until then. Each session integration nifra
 * ships runs every operation through `createWebApp`'s hook, in each of its modes. The registry at the end fails when the hook
 * learns a session cookie that no integration here covers.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import Credentials from "@auth/core/providers/credentials"
import { createSessions, MemorySessionStore, type SessionContext } from "@nifrajs/auth"
import { type AuthJSConfig, authjs } from "@nifrajs/authjs"
import type { AnyServer } from "@nifrajs/core"
import { buildManifest, createWebApp, type RenderAdapter } from "@nifrajs/web"

const SECRET = ["identity", "epoch", "invariant", "secret", "of", "32", "bytes"].join("-")

/** The browser's cookies, kept as a browser would from each response. */
type Jar = Map<string, string>

const cookieHeader = (jar: Jar): string => [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
const epochOf = (jar: Jar): string | undefined =>
  jar.get("__Host-nifra-epoch") ?? jar.get("nifra-epoch")

const keep = (jar: Jar, response: Response): void => {
  // What an integration tells the hook stays on the server.
  expect(response.headers.get("x-nifra-identity-renewed")).toBeNull()
  for (const line of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = line.split(";")
    const at = pair.indexOf("=")
    const name = pair.slice(0, at).trim()
    const gone = attributes.some((a) => {
      const [key = "", value = ""] = a.split("=")
      const k = key.trim().toLowerCase()
      return (k === "max-age" && Number(value) <= 0) || (k === "expires" && Date.parse(value) <= 0)
    })
    if (gone) jar.delete(name)
    else jar.set(name, pair.slice(at + 1).trim())
  }
}

const adapter: RenderAdapter = {
  renderToStream: () => new Blob(["<p>page</p>"]).stream(),
  hydrationHead: () => "",
}
const keepAliveApp = (use: (app: AnyServer) => AnyServer) =>
  createWebApp({
    adapter,
    clientEntry: "/c.js",
    manifest: buildManifest(["index.tsx"], () => async () => ({ default: () => null }), {
      keepAlive: ["index.tsx"],
    }),
    use,
  })

type Visit = (jar: Jar) => Promise<void>
type Step = Visit | { readonly none: string }

/** What an integration can do to the browser's session. */
interface Integration {
  readonly modes: Readonly<Record<string, () => Steps>>
}
interface Steps {
  /** A sign-in the way the integration documents it. */
  signIn(user: string): Visit
  /** A sign-in that keeps the session the browser already holds. */
  signInKeepingSession(user: string): Step
  /** A session that holds data before anyone signs in. */
  readonly anonymous: Step
  readonly renew: Visit
  readonly read: Visit
  readonly signOut: Visit
  /** Ending a session by emptying it rather than deleting it. */
  readonly clear: Step
  /** The same visitor writes session data that does not say who they are. */
  readonly writeOther: Step
  /** Whether the session knows which of its data says who the visitor is. */
  readonly identityKeys: boolean
}

const nifraSessions = (store: boolean, rolling: boolean, identityKeys: boolean) => (): Steps => {
  // Each request a second after the last, so a rolling expiry moves every time.
  let clock = Date.now()
  const options = {
    secret: SECRET,
    rolling,
    now: () => clock,
    ...(identityKeys ? { identity: ["userId" as const] } : {}),
  }
  const sessions = createSessions<{ userId: string; cart: number }>(
    store ? { ...options, store: new MemorySessionStore() } : options,
  )
  const signIn = async (c: SessionContext, user: string, keep: boolean): Promise<string> => {
    const session = await sessions.get(c)
    if (!keep) sessions.regenerate(session)
    session.set("userId", user)
    await sessions.commit(c, session)
    return "ok"
  }
  const app = keepAliveApp((a) =>
    a
      .post("/sign-in/:user", (c) => signIn(c, c.params.user, false))
      .post("/sign-in-keeping/:user", (c) => signIn(c, c.params.user, true))
      .post("/cart", async (c) => {
        const session = await sessions.get(c)
        session.set("cart", (session.get("cart") ?? 0) + 1)
        await sessions.commit(c, session)
        return "ok"
      })
      .get("/renew", async (c) => {
        await sessions.commit(c, await sessions.get(c))
        return "ok"
      })
      .get("/read", async (c) => {
        await sessions.get(c)
        return "ok"
      })
      .post("/sign-out", async (c) => {
        await sessions.destroy(c, await sessions.get(c))
        return "ok"
      })
      .post("/clear", async (c) => {
        const session = await sessions.get(c)
        session.clear()
        await sessions.commit(c, session)
        return "ok"
      }),
  )
  const visit =
    (method: string, path: string): Visit =>
    async (jar) => {
      clock += 1000
      const request = new Request(`https://app.test${path}`, {
        method,
        headers: { cookie: cookieHeader(jar) },
      })
      keep(jar, await app.fetch(request))
    }
  return {
    signIn: (user) => visit("POST", `/sign-in/${user}`),
    signInKeepingSession: (user) => visit("POST", `/sign-in-keeping/${user}`),
    anonymous: visit("POST", "/cart"),
    renew: visit("GET", "/renew"),
    read: visit("GET", "/read"),
    signOut: visit("POST", "/sign-out"),
    clear: visit("POST", "/clear"),
    writeOther: visit("POST", "/cart"),
    identityKeys,
  }
}

const authjsSessions = (): Steps => {
  const config: AuthJSConfig = {
    providers: [
      Credentials({
        credentials: { username: {} },
        authorize: (credentials) => {
          const user = String(credentials.username)
          return { id: user, name: user }
        },
      }),
    ],
    secret: SECRET,
    trustHost: true,
    logger: { error() {}, warn() {}, debug() {} },
  }
  const app = keepAliveApp((a) => a.use(authjs(config)).get("/read", () => "ok"))
  const send = async (jar: Jar, path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set("cookie", cookieHeader(jar))
    const response = await app.fetch(new Request(`https://app.test${path}`, { ...init, headers }))
    keep(jar, response)
    return response
  }
  const post = async (jar: Jar, path: string, fields: Record<string, string>): Promise<void> => {
    const body: unknown = await (await send(jar, "/api/auth/csrf")).json()
    const csrfToken =
      typeof body === "object" && body !== null && "csrfToken" in body ? String(body.csrfToken) : ""
    await send(jar, path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken, ...fields }),
    })
  }
  return {
    signIn: (user) => (jar) => post(jar, "/api/auth/callback/credentials", { username: user }),
    signInKeepingSession: () => ({ none: "Auth.js writes a new token at every sign-in" }),
    anonymous: { none: "Auth.js holds no session before a sign-in" },
    renew: async (jar) => void (await send(jar, "/api/auth/session")),
    read: async (jar) => void (await send(jar, "/read")),
    signOut: (jar) => post(jar, "/api/auth/signout", {}),
    clear: { none: "Auth.js ends a session only by signing out" },
    writeOther: {
      none: "Auth.js holds a session's data in its token, which changes only by update()",
    },
    identityKeys: true,
  }
}

const NIFRA_MODES = Object.fromEntries(
  [false, true].flatMap((store) =>
    [true, false].flatMap((rolling) =>
      [false, true].map((identityKeys) => [
        `${store ? "store" : "cookie"} mode, ${rolling ? "rolling" : "absolute"}${identityKeys ? ", identity keys" : ""}`,
        nifraSessions(store, rolling, identityKeys),
      ]),
    ),
  ),
)

const INTEGRATIONS: Readonly<Record<string, Integration>> = {
  "@nifrajs/auth": { modes: NIFRA_MODES },
  "@nifrajs/authjs": { modes: { "JWT session": authjsSessions } },
}

/** Each operation: who is signed in before it, what it does, and whether the visitor changes. */
const OPERATIONS: Readonly<
  Record<
    string,
    {
      readonly from: "nobody" | "ada" | "anonymous"
      readonly act: (steps: Steps) => Step
      readonly changes: boolean | ((steps: Steps) => boolean)
    }
  >
> = {
  "the same visitor's session renews": { from: "ada", act: (s) => s.renew, changes: false },
  "the same visitor reads a page": { from: "ada", act: (s) => s.read, changes: false },
  // Without identity keys the server cannot tell a cart from a role, so any write counts.
  "the same visitor writes other session data": {
    from: "ada",
    act: (s) => s.writeOther,
    changes: (s) => !s.identityKeys,
  },
  "a visitor signs in": { from: "nobody", act: (s) => s.signIn("ada"), changes: true },
  "a visitor signs in over an anonymous session": {
    from: "anonymous",
    act: (s) => s.signIn("ada"),
    changes: true,
  },
  "a visitor signs in over an anonymous session, keeping it": {
    from: "anonymous",
    act: (s) => s.signInKeepingSession("ada"),
    changes: true,
  },
  "the visitor switches to another account": {
    from: "ada",
    act: (s) => s.signIn("bob"),
    changes: true,
  },
  "the visitor switches to another account, keeping the session": {
    from: "ada",
    act: (s) => s.signInKeepingSession("bob"),
    changes: true,
  },
  "the visitor signs out": { from: "ada", act: (s) => s.signOut, changes: true },
  "the visitor signs out by emptying the session": {
    from: "ada",
    act: (s) => s.clear,
    changes: true,
  },
}

// A pairing still open runs as `test.failing`, so the fix that closes it fails here until it leaves.
const OPEN: Readonly<Record<string, string>> = {}

for (const [integration, { modes }] of Object.entries(INTEGRATIONS)) {
  describe(integration, () => {
    for (const [mode, open] of Object.entries(modes)) {
      for (const [operation, { from, act, changes: changesFor }] of Object.entries(OPERATIONS)) {
        const name = `${integration} ${mode}: ${operation}`
        const steps = open()
        const changes = typeof changesFor === "function" ? changesFor(steps) : changesFor
        const start =
          from === "anonymous" ? steps.anonymous : from === "ada" ? steps.signIn("ada") : undefined
        const step = act(steps)
        const skipped = [start, step].find(
          (s): s is { readonly none: string } => typeof s === "object",
        )
        if (skipped !== undefined || typeof step !== "function") {
          test.skip(`${name} (${skipped?.none})`, () => {})
          continue
        }
        const run = OPEN[name] === undefined ? test : test.failing
        run(`${mode}: ${operation} ${changes ? "rotates" : "keeps"} the epoch`, async () => {
          const jar: Jar = new Map()
          if (typeof start === "function") await start(jar)
          const before = epochOf(jar)
          // Three times, so a renewal a moment later is seen too.
          for (let i = 0; i < (changes ? 1 : 3); i++) await step(jar)
          const after = epochOf(jar)
          expect(after).toBeDefined()
          if (changes) expect(after).not.toBe(before)
          else expect(after).toBe(before)
        })
      }
    }
  })
}

describe("the registry", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../../packages/web/src/internal/identity-epoch.ts", import.meta.url)),
    "utf8",
  )
  // Session cookies the hook knows by name, and why the ones no integration here covers are left out.
  const COVERED: Readonly<Record<string, string>> = {
    nifra_session: "@nifrajs/auth",
    "authjs.session-token": "@nifrajs/authjs",
    "next-auth.session-token": "Auth.js before v5; @nifrajs/authjs runs v5, which names it authjs",
    ".session_token": "Better Auth, a server nifra does not ship",
  }

  test("every session cookie the hook knows is covered or names why not", () => {
    const defaults = source.match(/const IDENTITY_DEFAULTS = \[([^\]]*)\]/)?.[1] ?? ""
    const suffix = source.match(/const BETTER_AUTH_SESSION = "([^"]+)"/)?.[1]
    const known = [...defaults.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(known.length).toBeGreaterThan(0)
    expect([...known, suffix].sort()).toEqual(Object.keys(COVERED).sort())
  })

  test("every open pairing names one this suite runs", () => {
    const names = Object.entries(INTEGRATIONS).flatMap(([integration, { modes }]) =>
      Object.keys(modes).flatMap((mode) =>
        Object.keys(OPERATIONS).map((operation) => `${integration} ${mode}: ${operation}`),
      ),
    )
    for (const open of Object.keys(OPEN)) expect(names).toContain(open)
  })
})
