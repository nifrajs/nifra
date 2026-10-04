import { describe, expect, test } from "bun:test"
import Credentials from "@auth/core/providers/credentials"
import GitHub from "@auth/core/providers/github"
import { server } from "@nifrajs/core"
import { createAuthClient } from "../src/client.ts"
import { type AuthJSConfig, authjs, getSession, requireAuthUser } from "../src/index.ts"

const testAuthSecret = ["test", "only", "not", "secret"].join("-")

const config: AuthJSConfig = {
  providers: [
    Credentials({
      credentials: { username: {}, password: {} },
      // biome-ignore lint/suspicious/noExplicitAny: provider credential shape
      authorize: async (creds: any) =>
        creds?.password === "secret" ? { id: "1", name: "Ada" } : null,
    }),
  ],
  secret: testAuthSecret,
  trustHost: true,
  // Auth.js logs expected error paths (bad credentials) to the console; the assertions below
  // verify the behavior, so keep the output clean.
  logger: { error() {}, warn() {}, debug() {} },
}

const app = server()
  .use(authjs(config))
  .get("/me", async (c) => ({ user: (await getSession(c.req, config))?.user ?? null }))
  .get("/guarded", async (c) => ({ user: await requireAuthUser(c.req, config) }))

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init)
}

/** Complete the double-submit CSRF dance and return the session cookie jar. */
async function loginJar(username: string, password: string): Promise<string> {
  const csrfRes = await app.fetch(req("/api/auth/csrf"))
  expect(csrfRes.status).toBe(200)
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
  const csrfCookies = csrfRes.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ")
  const callback = await app.fetch(
    req("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: csrfCookies },
      body: new URLSearchParams({ csrfToken, username, password }),
    }),
  )
  expect(callback.status).toBe(302)
  return callback.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ")
}

describe("@nifrajs/authjs", () => {
  test("credentials sign-in sets a session cookie the session endpoint honors", async () => {
    const jar = await loginJar("ada", "secret")
    expect(jar).toContain("authjs.session-token=")
    const session = await app.fetch(req("/api/auth/session", { headers: { cookie: jar } }))
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ user: { name: "Ada" } })
  })

  test("wrong credentials redirect to the error page, no session", async () => {
    const csrfRes = await app.fetch(req("/api/auth/csrf"))
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
    const csrfCookies = csrfRes.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ")
    const callback = await app.fetch(
      req("/api/auth/callback/credentials", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: csrfCookies },
        body: new URLSearchParams({ csrfToken, username: "ada", password: "wrong" }),
      }),
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toContain("error=CredentialsSignin")
    expect(callback.headers.getSetCookie().join(";")).not.toContain("authjs.session-token=")
  })

  test("getSession returns null anonymously; requireAuthUser guards", async () => {
    expect(await getSession(req("/me"), config)).toBeNull()

    const jar = await loginJar("ada", "secret")
    const authed = await app.fetch(req("/me", { headers: { cookie: jar } }))
    expect(await authed.json()).toMatchObject({ user: { name: "Ada" } })
    const guarded = await app.fetch(req("/guarded", { headers: { cookie: jar } }))
    expect(guarded.status).toBe(200)

    const anon = await app.fetch(req("/guarded"))
    expect(anon.status).toBe(401)
    expect(await anon.json()).toEqual({ ok: false, error: "unauthorized" })
  })

  test("missing secret fails loud, never silently unsigned", async () => {
    const sloppy = server()
      // biome-ignore lint/suspicious/noExplicitAny: deliberately secretless config
      .use(authjs({ providers: [], trustHost: true } as any))
      .get("/", () => ({ ok: true }))
    const response = await sloppy.fetch(req("/api/auth/session"))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: "auth_misconfigured" })
    await expect(getSession(req("/"), { providers: [] })).rejects.toThrow(/AUTH_SECRET/)
  })

  test("configured authUrl cannot be overridden by forwarded headers", async () => {
    const oauth = server().use(
      authjs(
        {
          ...config,
          providers: [GitHub({ clientId: "client", clientSecret: "client-secret" })],
        },
        { authUrl: "https://app.example.com/" },
      ),
    )
    const response = await oauth.fetch(
      new Request("http://internal.test/api/auth/signin/github", {
        headers: {
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
        },
      }),
    )
    expect(response.status).toBe(302)
    const location = response.headers.get("location") ?? ""
    expect(location).toMatch(/^https:\/\/app\.example\.com\/api\/auth\//)
    expect(location).not.toContain("evil.example")
  })

  describe("in production", () => {
    const { trustHost: _trustHost, ...untrusted } = config
    async function inProduction<T>(
      run: () => T | PromiseLike<T>,
      extra: Record<string, string> = {},
    ) {
      const saved = { ...process.env }
      Object.assign(process.env, { NODE_ENV: "production" }, extra)
      try {
        return await run()
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
        Object.assign(process.env, saved)
      }
    }

    test("an unset trustHost refuses a request whose Host header would name the origin", async () => {
      const mounted = server().use(authjs(untrusted))
      const response = await inProduction(() =>
        mounted.fetch(new Request("http://evil.example/api/auth/providers")),
      )
      expect(response.status).toBe(500)
      expect(await response.text()).not.toContain("evil.example")
    })

    test("a configured origin is trusted, and the Host header cannot replace it", async () => {
      const viaOption = server().use(authjs(untrusted, { authUrl: "https://app.example.com" }))
      const viaEnv = server().use(authjs(untrusted))
      for (const [mounted, extra] of [
        [viaOption, {}],
        [viaEnv, { AUTH_URL: "https://app.example.com/api/auth" }],
      ] as const) {
        const response = await inProduction(
          () => mounted.fetch(new Request("http://evil.example/api/auth/providers")),
          extra,
        )
        expect(response.status).toBe(200)
        const body = await response.text()
        expect(body).toContain("https://app.example.com/api/auth/")
        expect(body).not.toContain("evil.example")
      }
    })

    test("getSession reads the session the mount set behind a configured https origin", async () => {
      const options = { authUrl: "https://app.example.com" }
      const mounted = server().use(authjs(untrusted, options))
      const internal = (path: string, init?: RequestInit) =>
        mounted.fetch(new Request(`http://10.0.0.5:3000${path}`, init))
      const session = await inProduction(async () => {
        const csrfRes = await internal("/api/auth/csrf")
        const csrf: unknown = await csrfRes.json()
        if (typeof csrf !== "object" || csrf === null || !("csrfToken" in csrf)) {
          throw new Error("no csrf token")
        }
        const csrfToken = String(csrf.csrfToken)
        const csrfCookies = csrfRes.headers
          .getSetCookie()
          .map((line) => line.split(";")[0])
          .join("; ")
        const callback = await internal("/api/auth/callback/credentials", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", cookie: csrfCookies },
          body: new URLSearchParams({ csrfToken, username: "ada", password: "secret" }),
        })
        const jar = callback.headers
          .getSetCookie()
          .map((line) => line.split(";")[0])
          .join("; ")
        expect(jar).toContain("__Secure-authjs.session-token=")
        return getSession(
          new Request("http://10.0.0.5:3000/me", { headers: { cookie: jar } }),
          untrusted,
          options,
        )
      })
      expect(session?.user?.name).toBe("Ada")
    })
  })

  test("getSession can resolve an edge platform secret", async () => {
    const jar = await loginJar("ada", "secret")
    const { secret, ...withoutSecret } = config
    if (typeof secret !== "string") throw new Error("test config secret must be a string")
    const session = await getSession(req("/me", { headers: { cookie: jar } }), withoutSecret, {
      env: { AUTH_SECRET: secret },
    })
    expect(session?.user?.name).toBe("Ada")
  })
})

describe("the client against the mount", () => {
  test("signIn() completes Auth.js v5's POST sign-in and lands on the provider", async () => {
    const mounted = server().use(
      authjs({
        providers: [GitHub({ clientId: "client", clientSecret: "client-secret" })],
        secret: testAuthSecret,
        trustHost: true,
        logger: { error() {}, warn() {}, debug() {} },
      }),
    )
    const jar = new Map<string, string>()
    const viaApp = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      if (jar.size > 0) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "))
      const response = await mounted.fetch(
        new Request(new URL(String(input), "http://localhost"), { ...init, headers }),
      )
      for (const cookie of response.headers.getSetCookie()) {
        const [pair = ""] = cookie.split(";")
        const eq = pair.indexOf("=")
        jar.set(pair.slice(0, eq), pair.slice(eq + 1))
      }
      return response
    }
    const navigated: string[] = []
    const previous = Reflect.get(globalThis, "window")
    Reflect.set(globalThis, "window", {
      location: {
        href: "http://localhost/page",
        origin: "http://localhost",
        assign: (url: string) => navigated.push(url),
      },
    })
    try {
      await createAuthClient({
        fetch: Object.assign(viaApp, { preconnect: fetch.preconnect }),
      }).signIn("github", { callbackUrl: "/dashboard" })
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "window")
      else Reflect.set(globalThis, "window", previous)
    }
    expect(navigated).toHaveLength(1)
    expect(navigated[0]).toStartWith("https://github.com/login/oauth/authorize?")
  })
})
