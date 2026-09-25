import { describe, expect, test } from "bun:test"
import Credentials from "@auth/core/providers/credentials"
import GitHub from "@auth/core/providers/github"
import { server } from "@nifrajs/core"
import { type AuthJSConfig, authjs, getSession, requireAuthUser } from "../src/index.ts"

const config: AuthJSConfig = {
  providers: [
    Credentials({
      credentials: { username: {}, password: {} },
      // biome-ignore lint/suspicious/noExplicitAny: provider credential shape
      authorize: async (creds: any) =>
        creds?.password === "secret" ? { id: "1", name: "Ada" } : null,
    }),
  ],
  secret: "test-secret-32-bytes-long-abcdef",
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
