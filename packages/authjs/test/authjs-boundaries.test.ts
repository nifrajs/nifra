import { describe, expect, test } from "bun:test"
import { decode, encode } from "@auth/core/jwt"
import Credentials from "@auth/core/providers/credentials"
import GitHub from "@auth/core/providers/github"
import { server } from "@nifrajs/core"
import { type AuthJSConfig, authjs, getSession, requireAuthUser } from "../src/index.ts"

const SECRET = ["boundary", "test", "only", "secret"].join("-")
const ORIGIN = "http://internal.test"

const github = GitHub({ clientId: "client", clientSecret: "client-secret" })
const config: AuthJSConfig = {
  providers: [github],
  secret: SECRET,
  trustHost: true,
  logger: { error() {}, warn() {}, debug() {} },
}

const mount = (options: Parameters<typeof authjs>[1] = {}, over: Partial<AuthJSConfig> = {}) =>
  server().use(authjs({ ...config, ...over }, options))

const signIn = (
  app: ReturnType<typeof mount>,
  headers: Record<string, string> = {},
  path = "/api/auth/signin/github",
) => app.fetch(new Request(`${ORIGIN}${path}`, { headers }))

const redirectOf = async (response: Response): Promise<string> => {
  expect(response.status).toBe(302)
  return response.headers.get("location") ?? ""
}

const withEnv = async (vars: Record<string, string | undefined>, run: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const sessionRequest = (headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/me`, { headers })

describe("the secret", () => {
  const bare = { providers: [], trustHost: true } as unknown as AuthJSConfig

  test("comes from AUTH_SECRET in the process environment when nothing is configured", async () => {
    await withEnv({ AUTH_SECRET: SECRET }, async () => {
      expect(await getSession(sessionRequest(), bare)).toBeNull()
    })
  })

  test("an empty environment value is no secret", async () => {
    await withEnv({ AUTH_SECRET: "" }, async () => {
      await expect(getSession(sessionRequest(), bare)).rejects.toThrow(/AUTH_SECRET/)
    })
  })

  test("a platform binding wins over the process environment", async () => {
    await withEnv({ AUTH_SECRET: undefined }, async () => {
      expect(await getSession(sessionRequest(), bare, { env: { AUTH_SECRET: SECRET } })).toBeNull()
    })
  })

  test("a binding that is not a string is no secret", async () => {
    await withEnv({ AUTH_SECRET: undefined }, async () => {
      await expect(
        getSession(sessionRequest(), bare, { env: { AUTH_SECRET: 12345 } }),
      ).rejects.toThrow(/AUTH_SECRET/)
    })
  })

  test("an empty binding falls through to the process environment", async () => {
    await withEnv({ AUTH_SECRET: SECRET }, async () => {
      expect(await getSession(sessionRequest(), bare, { env: { AUTH_SECRET: "" } })).toBeNull()
    })
  })

  test("secretEnv names the variable, and the mount answers 500 without it", async () => {
    await withEnv({ AUTH_SECRET: undefined, CUSTOM_SECRET: SECRET }, async () => {
      expect(await getSession(sessionRequest(), bare, { secretEnv: "CUSTOM_SECRET" })).toBeNull()
      const app = server().use(authjs(bare))
      const response = await app.fetch(new Request(`${ORIGIN}/api/auth/session`))
      expect(response.status).toBe(500)
    })
  })

  test("a string secret signs the session token whole, not one character at a time", async () => {
    const credentials: AuthJSConfig = {
      ...config,
      providers: [
        Credentials({
          credentials: { username: {} },
          authorize: async () => ({ id: "1", name: "Ada" }),
        }),
      ],
    }
    const app = server().use(authjs(credentials))
    const csrf = await app.fetch(new Request(`${ORIGIN}/api/auth/csrf`))
    const { csrfToken } = (await csrf.json()) as { csrfToken: string }
    const cookies = csrf.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ")
    const callback = await app.fetch(
      new Request(`${ORIGIN}/api/auth/callback/credentials`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies },
        body: new URLSearchParams({ csrfToken, username: "ada" }),
      }),
    )
    const line = callback.headers.getSetCookie().find((l) => l.startsWith("authjs.session-token="))
    const token = line?.split(";")[0]?.slice("authjs.session-token=".length) ?? ""
    expect(await decode({ token, secret: SECRET, salt: "authjs.session-token" })).not.toBeNull()
  })
})

describe("authUrl and the base path", () => {
  test("an authUrl carrying only a query is refused", () => {
    expect(() => authjs(config, { authUrl: "https://app.example.com/?next=1" })).toThrow(
      /authUrl must be an absolute http\(s\) origin/,
    )
  })

  test("authjs returns a plugin that can be applied", () => {
    expect(authjs(config)).toBeDefined()
  })

  test("authUrl rewrites the public origin of the redirect", async () => {
    const location = await redirectOf(
      await signIn(mount({ authUrl: "https://app.example.com" }), {
        "x-forwarded-host": "evil.example",
      }),
    )
    expect(location).toMatch(/^https:\/\/app\.example\.com\/api\/auth\//)
  })

  test("the base path comes from the config when the options name none, and loses trailing slashes", async () => {
    const fromConfig = mount({}, { basePath: "/identity" })
    expect((await signIn(fromConfig, {}, "/identity/signin/github")).status).toBe(302)
    const slashes = mount({ basePath: "/login///" })
    expect((await signIn(slashes, {}, "/login/signin/github")).status).toBe(302)
    const root = mount({ basePath: "/" })
    expect((await signIn(root, {}, "/api/auth/signin/github")).status).toBe(302)
  })

  test("getSession reads under the configured base path", async () => {
    const calls: string[] = []
    const probe: AuthJSConfig = {
      ...config,
      basePath: "/identity",
      callbacks: {
        session({ session }) {
          calls.push("session")
          return session
        },
      },
    }
    expect(await getSession(sessionRequest(), probe)).toBeNull()
    expect(await getSession(sessionRequest(), probe, { basePath: "/other" })).toBeNull()
  })
})

describe("Auth.js environment defaults", () => {
  test("AUTH_TRUST_HOST in a binding lets a production host through", async () => {
    const untrusted: AuthJSConfig = { providers: [github], secret: SECRET, logger: config.logger }
    const trusted = await getSession(sessionRequest(), untrusted, {
      env: { NODE_ENV: "production", AUTH_TRUST_HOST: "true" },
    })
    expect(trusted).toBeNull()
    const refused = await getSession(sessionRequest(), untrusted, {
      env: { NODE_ENV: "production" },
    })
    expect(refused).toBeNull()
  })

  test("the provider id and secret come from AUTH_<PROVIDER>_ variables", async () => {
    const bare = GitHub({})
    const app = server().use(authjs({ ...config, providers: [bare] }))
    await withEnv(
      { AUTH_GITHUB_ID: "from-env", AUTH_GITHUB_SECRET: "from-env-secret" },
      async () => {
        const csrf = await app.fetch(new Request(`${ORIGIN}/api/auth/csrf`))
        const { csrfToken } = (await csrf.json()) as { csrfToken: string }
        const response = await app.fetch(
          new Request(`${ORIGIN}/api/auth/signin/github`, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              cookie: csrf.headers
                .getSetCookie()
                .map((line) => line.split(";")[0])
                .join("; "),
            },
            body: new URLSearchParams({ csrfToken }),
          }),
        )
        expect(await redirectOf(response)).toContain("client_id=from-env")
      },
    )
  })
})

describe("the request Auth.js sees", () => {
  const providers = async (app: ReturnType<typeof mount>, headers: Record<string, string>) =>
    (await (
      await app.fetch(new Request(`${ORIGIN}/api/auth/providers`, { headers }))
    ).json()) as Record<string, { signinUrl: string }>

  test("forwarded host and protocol headers name nothing without trustProxy", async () => {
    const app = mount()
    const seen = await providers(app, {
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
      forwarded: "host=evil.example;proto=https",
    })
    expect(seen.github?.signinUrl).toBe(`${ORIGIN}/api/auth/signin/github`)
  })

  test("a Host header that disagrees with the URL names nothing", async () => {
    const seen = await providers(mount(), { host: "evil.example" })
    expect(seen.github?.signinUrl).toBe(`${ORIGIN}/api/auth/signin/github`)
  })

  test("with a configured origin the Host header is the configured host", async () => {
    const seen = await providers(mount({ authUrl: "https://app.example.com" }), {
      host: "evil.example",
    })
    expect(seen.github?.signinUrl).toBe("https://app.example.com/api/auth/signin/github")
  })
})

describe("trustProxy", () => {
  const proxied = mount({ trustProxy: true })
  const redirectUri = async (headers: Record<string, string>): Promise<string> =>
    await redirectOf(await signIn(proxied, headers))

  test("takes only the protocol when only that is forwarded", async () => {
    expect(await redirectUri({ "x-forwarded-proto": "https" })).toContain(
      "https://internal.test/api/auth/",
    )
  })

  test("takes only the host when only that is forwarded", async () => {
    expect(await redirectUri({ "x-forwarded-host": "app.example.com" })).toContain(
      "http://app.example.com/api/auth/",
    )
  })

  test("falls back to the Host header", async () => {
    expect(await redirectUri({ host: "app.example.com" })).toContain(
      "http://app.example.com/api/auth/",
    )
  })

  test("accepts a protocol written with its colon", async () => {
    expect(await redirectUri({ "x-forwarded-proto": "https:" })).toContain(
      "https://internal.test/api/auth/",
    )
  })

  test("a bad protocol discards the whole forwarded URL", async () => {
    expect(
      await redirectUri({ "x-forwarded-proto": "ftp", "x-forwarded-host": "app.example.com" }),
    ).toContain("http://internal.test/api/auth/")
  })

  test("getSession honours the same opt-in", async () => {
    await expect(
      getSession(sessionRequest({ "x-forwarded-proto": "https" }), config, { trustProxy: true }),
    ).resolves.toBeNull()
  })
})

describe("guards", () => {
  const thrownBy = async (options: Parameters<typeof requireAuthUser>[2]) => {
    try {
      await requireAuthUser(sessionRequest(), config, options)
    } catch (error) {
      return Reflect.get(Object(error), "plain") as {
        status: number
        body?: unknown
        headers?: Record<string, string>
      }
    }
    throw new Error("the guard let an anonymous request through")
  }

  test("denies with 401 JSON by default", async () => {
    expect(await thrownBy(undefined)).toEqual({
      status: 401,
      body: { ok: false, error: "unauthorized" },
    })
  })

  test("a custom denial keeps the default body and status for what it leaves out", async () => {
    expect(await thrownBy({ unauthenticated: { status: 403 } })).toMatchObject({
      status: 403,
      body: { ok: false, error: "unauthorized" },
    })
    expect(
      await thrownBy({ unauthenticated: { headers: { "www-authenticate": "Bearer" } } }),
    ).toMatchObject({
      status: 401,
      headers: { "www-authenticate": "Bearer" },
    })
  })

  test("a body present but undefined sends none", async () => {
    const plain = await thrownBy({ unauthenticated: { body: undefined } })
    expect(plain.body).toBeUndefined()
  })

  test("a denial without headers carries none", async () => {
    const plain = await thrownBy({ unauthenticated: { status: 410 } })
    expect(plain.headers).toBeUndefined()
  })

  test("redirects to a same-origin path with 302", async () => {
    expect(await thrownBy({ redirectTo: "/login" })).toMatchObject({
      status: 302,
      headers: { location: "/login" },
    })
  })

  test("a redirect and a custom denial together are refused", async () => {
    await expect(
      requireAuthUser(sessionRequest(), config, {
        redirectTo: "/login",
        unauthenticated: { status: 403 },
      }),
    ).rejects.toThrow(/redirectTo or unauthenticated, not both/)
  })

  test.each([
    [400, true],
    [599, true],
    [399, false],
    [600, false],
    [401.5, false],
  ])("a denial status of %p is accepted: %p", async (code, accepted) => {
    const run = requireAuthUser(sessionRequest(), config, { unauthenticated: { status: code } })
    if (accepted) await expect(run).rejects.not.toBeInstanceOf(RangeError)
    else await expect(run).rejects.toBeInstanceOf(RangeError)
  })
})

describe("getSession", () => {
  test("a host Auth.js does not trust reads as no session", async () => {
    const untrusted: AuthJSConfig = { providers: [github], secret: SECRET, logger: config.logger }
    expect(
      await getSession(sessionRequest(), untrusted, { env: { NODE_ENV: "production" } }),
    ).toBeNull()
  })
})

describe("the request a credentials provider receives", () => {
  const capture = async (
    options: Parameters<typeof authjs>[1],
    headers: Record<string, string>,
  ) => {
    let seen: Headers | undefined
    const app = server().use(
      authjs(
        {
          ...config,
          providers: [
            Credentials({
              credentials: { username: {} },
              authorize: async (_credentials, request) => {
                seen = request.headers
                return { id: "1" }
              },
            }),
          ],
        },
        options,
      ),
    )
    const csrf = await app.fetch(new Request(`${ORIGIN}/api/auth/csrf`, { headers }))
    const { csrfToken } = (await csrf.json()) as { csrfToken: string }
    const cookie = csrf.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ")
    await app.fetch(
      new Request(`${ORIGIN}/api/auth/callback/credentials`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie, ...headers },
        body: new URLSearchParams({ csrfToken, username: "ada" }),
      }),
    )
    if (seen === undefined) throw new Error("authorize was not called")
    return seen
  }

  test("carries no forwarded routing headers and the URL's own host", async () => {
    const seen = await capture(
      {},
      {
        forwarded: "host=evil.example;proto=https",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
        host: "evil.example",
      },
    )
    expect(seen.get("forwarded")).toBeNull()
    expect(seen.get("x-forwarded-host")).toBeNull()
    expect(seen.get("x-forwarded-proto")).toBeNull()
    expect(seen.get("host")).toBe("internal.test")
  })

  test("names the trusted forwarded host as its host", async () => {
    const seen = await capture(
      { trustProxy: true },
      { "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https" },
    )
    expect(seen.get("x-forwarded-host")).toBeNull()
    expect(seen.get("host")).toBe("app.example.com")
  })
})

describe("reading a session token", () => {
  const token = (salt: string, claims: Record<string, unknown> = { name: "Ada", sub: "1" }) =>
    encode({ token: claims, secret: SECRET, salt })

  test("getSession and requireAuthUser return the signed-in user", async () => {
    const cookie = `authjs.session-token=${await token("authjs.session-token")}`
    const request = () => sessionRequest({ cookie })
    expect((await getSession(request(), config))?.user?.name).toBe("Ada")
    expect(await requireAuthUser(request(), config)).toMatchObject({ name: "Ada" })
  })

  test("a session the callbacks left without a user is no session", async () => {
    const cookie = `authjs.session-token=${await token("authjs.session-token")}`
    const stripped: AuthJSConfig = {
      ...config,
      callbacks: { session: () => ({ expires: "2999-01-01T00:00:00.000Z" }) as never },
    }
    expect(await getSession(sessionRequest({ cookie }), stripped)).toBeNull()
  })

  test("a request the proxy says is https reads the __Secure- cookie only when trusted", async () => {
    const name = "__Secure-authjs.session-token"
    const request = async () =>
      sessionRequest({ cookie: `${name}=${await token(name)}`, "x-forwarded-proto": "https" })
    expect((await getSession(await request(), config, { trustProxy: true }))?.user?.name).toBe(
      "Ada",
    )
    expect(await getSession(await request(), config)).toBeNull()
  })

  test("a null environment binding is ignored", async () => {
    expect(await getSession(sessionRequest(), config, { env: null })).toBeNull()
  })
})
