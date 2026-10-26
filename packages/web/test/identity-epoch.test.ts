import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { documentEpoch, epochOf } from "../src/identity.ts"
import {
  buildManifest,
  createWebApp,
  type RenderAdapter,
  rotateIdentityEpoch,
} from "../src/index.ts"
import { identityEpochHook } from "../src/internal/identity-epoch.ts"

const EPOCH = /^__Host-nifra-epoch=[0-9a-f]{32}; Path=\/; SameSite=Lax; Secure/
const LOCAL_EPOCH = /^nifra-epoch=[0-9a-f]{32}; Path=\/; SameSite=Lax$/

// Runs the hook over one response's `Set-Cookie` lines; returns the epoch cookie it added, if any.
const run = (
  setCookies: readonly string[],
  options: {
    readonly cookie?: string
    readonly url?: string
    readonly forwardedProto?: string
    readonly hook?: ReturnType<typeof identityEpochHook>
  } = {},
): string | undefined => {
  const headers = new Headers()
  for (const line of setCookies) headers.append("set-cookie", line)
  const hook = options.hook ?? identityEpochHook({}, false)
  hook(headers, {
    url: options.url ?? "https://app.test/login",
    header: (name) =>
      name === "cookie"
        ? (options.cookie ?? null)
        : name === "x-forwarded-proto"
          ? (options.forwardedProto ?? null)
          : null,
  })
  const added = headers.getSetCookie().slice(setCookies.length)
  expect(added.length).toBeLessThanOrEqual(1)
  return added[0]
}

let warn: ReturnType<typeof spyOn> | undefined
afterEach(() => {
  warn?.mockRestore()
  warn = undefined
})

test("documentEpoch reads the cookies once per synchronous run", async () => {
  const described = Object.getOwnPropertyDescriptor(globalThis, "document")
  let reads = 0
  let cookie = "theme=dark; nifra-epoch=one"
  Object.defineProperty(globalThis, "document", {
    value: {
      get cookie() {
        reads++
        return cookie
      },
    },
    configurable: true,
  })
  try {
    // A run that already read before this test began holds its value until it ends.
    await Promise.resolve()
    expect([documentEpoch(), documentEpoch(), reads]).toEqual(["one", "one", 1])
    cookie = "nifra-epoch=two"
    await Promise.resolve()
    expect([documentEpoch(), reads]).toEqual(["two", 2])
  } finally {
    if (described === undefined) Reflect.deleteProperty(globalThis, "document")
    else Object.defineProperty(globalThis, "document", described)
  }
})

describe("the identity epoch hook", () => {
  test("a sign-in rotates the epoch with the session cookie's lifetime", () => {
    const epoch = run([
      "nifra_session=abc.sig; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax",
    ])
    expect(epoch).toMatch(EPOCH)
    expect(epoch).toEndWith("; Max-Age=600")
  })

  test("each rotation is a fresh 128-bit value", () => {
    const first = run(["nifra_session=a; HttpOnly; Secure"])
    const second = run(["nifra_session=a; HttpOnly; Secure"])
    expect(first?.split(";")[0]).not.toBe(second?.split(";")[0])
  })

  test("a rolling session that re-sends its value renews the epoch it holds", () => {
    const held = "0123456789abcdef0123456789abcdef"
    expect(
      run(["nifra_session=abc.sig; Max-Age=600; HttpOnly; Secure"], {
        cookie: `theme=dark; nifra_session=abc.sig; __Host-nifra-epoch=${held}`,
      }),
    ).toBe(`__Host-nifra-epoch=${held}; Path=/; SameSite=Lax; Secure; Max-Age=600`)
    const expires = "Wed, 21 Oct 2099 07:28:00 GMT"
    expect(
      run([`nifra_session=abc.sig; Expires=${expires}; HttpOnly`], {
        cookie: `nifra_session=abc.sig; nifra-epoch=${held}`,
        url: "http://localhost:3000/",
      }),
    ).toBe(`nifra-epoch=${held}; Path=/; SameSite=Lax; Expires=${expires}`)
  })

  test("a cookie-mode session re-signed with the same data renews the epoch it holds", () => {
    const held = "0123456789abcdef0123456789abcdef"
    const signed = (data: string, expiresAt: number) =>
      encodeURIComponent(`{"data":${data},"expiresAt":${expiresAt}}`) + `.sig${expiresAt}`
    const renew = (data: string) =>
      run([`nifra_session=${signed(data, 2000)}; Max-Age=600; HttpOnly; Secure`], {
        cookie: `nifra_session=${signed('{"userId":"ada"}', 1000)}; __Host-nifra-epoch=${held}`,
      })
    expect(renew('{"userId":"ada"}')).toBe(
      `__Host-nifra-epoch=${held}; Path=/; SameSite=Lax; Secure; Max-Age=600`,
    )
    for (const data of ['{"userId":"bob"}', "{}", '{"userId":"ada","cart":1}']) {
      expect({ data, epoch: renew(data) }).toEqual({ data, epoch: expect.stringMatching(EPOCH) })
      expect(renew(data)).not.toContain(held)
    }
  })

  test("a changed value that is not a cookie-mode session rotates, whatever it holds", () => {
    const held = "0123456789abcdef0123456789abcdef"
    for (const [before, after] of [
      ['{"data":{},"expiresAt":1}', '{"data":{},"expiresAt":2}'],
      // Unsigned, yet JSON once the last character is cut, or once leading space is trimmed.
      ['{"data":{},"expiresAt":1}}', '{"data":{},"expiresAt":2}}'],
      [' {"data":{},"expiresAt":1}.a', ' {"data":{},"expiresAt":2}.b'],
      ['{"data":{}}.a', '{"data":{}}.b'],
      ['{"data":1,"expiresAt":1}.a', '{"data":1,"expiresAt":2}.b'],
      ["{not json.a", "{not json.b"],
      ["tok.a", "tok.b"],
    ] as const) {
      const epoch = run([`nifra_session=${encodeURIComponent(after)}; Max-Age=600; HttpOnly`], {
        cookie: `nifra_session=${encodeURIComponent(before)}; __Host-nifra-epoch=${held}`,
      })
      expect({ before, epoch }).toEqual({ before, epoch: expect.stringMatching(EPOCH) })
      expect(epoch).not.toContain(held)
    }
  })

  test("a renewal whose epoch is gone or not one nifra wrote sets a fresh one", () => {
    for (const cookie of ["nifra_session=abc.sig", "nifra_session=abc.sig; __Host-nifra-epoch=x"]) {
      const epoch = run(["nifra_session=abc.sig; Max-Age=600; HttpOnly; Secure"], { cookie })
      expect(epoch).toMatch(EPOCH)
      expect(epoch).not.toStartWith("__Host-nifra-epoch=x;")
      expect(epoch).toEndWith("; Max-Age=600")
    }
  })

  test("a session re-sent without a lifetime leaves the epoch alone", () => {
    expect(
      run(["nifra_session=abc.sig; HttpOnly; Secure", "theme=dark; Max-Age=60"], {
        cookie: "theme=dark; nifra_session=abc.sig",
      }),
    ).toBeUndefined()
  })

  test("a value encoded on the wire compares as the request decodes it", () => {
    expect(
      run(["better-auth.session_token=tok%3D.sig; HttpOnly; Secure"], {
        cookie: "better-auth.session_token=tok%3D.sig",
      }),
    ).toBeUndefined()
    expect(
      run(['nifra_session="quoted"; HttpOnly; Secure'], { cookie: "nifra_session=quoted" }),
    ).toBeUndefined()
  })

  test("a sign-out that deletes the session cookie rotates the epoch for the browser session", () => {
    const at = "Thu, 01 Jan 1970 00:00:00 GMT"
    for (const deletion of [
      "nifra_session=; Max-Age=0; Path=/",
      `nifra_session=; Expires=${at}; Path=/`,
    ]) {
      const epoch = run([deletion], { cookie: "nifra_session=abc.sig" })
      expect(epoch).toMatch(EPOCH)
      expect(epoch).not.toContain("Max-Age")
      expect(epoch).not.toContain("Expires")
    }
  })

  test("deleting a session cookie the request did not carry rotates nothing", () => {
    expect(run(["nifra_session=; Max-Age=0"])).toBeUndefined()
  })

  test("Better Auth and Auth.js session cookies count by their default names", () => {
    for (const name of [
      "better-auth.session_token",
      "__Secure-better-auth.session_token",
      "authjs.session-token",
      "__Secure-authjs.session-token",
      "__Secure-authjs.session-token.1",
      "next-auth.session-token",
      "__Host-nifra_session",
    ]) {
      expect({ name, epoch: run([`${name}=v; HttpOnly; Secure`]) }).toEqual({
        name,
        epoch: expect.stringMatching(EPOCH),
      })
    }
  })

  test("an Expires date's comma does not split the cookie list", () => {
    const expires = "Wed, 21 Oct 2099 07:28:00 GMT"
    const epoch = run([`theme=dark; Expires=${expires}`, `nifra_session=new; Expires=${expires}`], {
      cookie: "theme=dark; nifra_session=old",
    })
    expect(epoch).toEndWith(`; Expires=${expires}`)
  })

  test("the first identity cookie still set gives the lifetime", () => {
    const epoch = run(
      ["authjs.session-token=; Max-Age=0", "nifra_session=new; Max-Age=60; HttpOnly; Secure"],
      { cookie: "authjs.session-token=old" },
    )
    expect(epoch).toEndWith("; Max-Age=60")
  })

  test("local http dev uses the unprefixed cookie, without Secure", () => {
    expect(run(["nifra_session=a; HttpOnly"], { url: "http://localhost:3000/login" })).toMatch(
      LOCAL_EPOCH,
    )
  })

  test("a Secure session cookie or a forwarded https keeps the prefixed cookie behind a proxy", () => {
    expect(run(["nifra_session=a; HttpOnly; Secure"], { url: "http://app.internal/" })).toMatch(
      EPOCH,
    )
    expect(
      run(["nifra_session=a; HttpOnly"], { url: "http://app.internal/", forwardedProto: "https" }),
    ).toMatch(EPOCH)
  })

  test("a sign-out behind a TLS proxy that forwards nothing rotates the prefixed epoch the client reads", () => {
    const epoch = run(["nifra_session=; Path=/; Max-Age=0"], {
      url: "http://app.internal/logout",
      cookie: "nifra_session=abc.sig; __Host-nifra-epoch=0123456789abcdef0123456789abcdef",
    })
    expect(epoch).toMatch(EPOCH)
    expect(epochOf(`${epoch?.split(";")[0]}; nifra-epoch=stale`)).not.toBe(
      "0123456789abcdef0123456789abcdef",
    )
  })

  test("a response that already sets the epoch gets no second one", () => {
    expect(
      run(["nifra_session=a; HttpOnly; Secure", "__Host-nifra-epoch=x; Path=/; Secure"]),
    ).toBeUndefined()
  })

  test("identityCookies adds a session cookie by name, prefixes and chunks included", () => {
    const hook = identityEpochHook({ identityCookies: ["sid"] }, false)
    expect(run(["__Secure-sid=v; HttpOnly; Secure"], { hook })).toMatch(EPOCH)
    expect(run(["sid.0=v; HttpOnly; Secure"], { hook })).toMatch(EPOCH)
  })

  test("a Better Auth session cookie counts under any cookiePrefix", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {})
    const hook = identityEpochHook({}, true)
    const signIn = [
      "__Secure-orbit.session_token=t.sig; Max-Age=600; Path=/; HttpOnly; Secure",
      "__Secure-orbit.session_data=d; Max-Age=300; Path=/; HttpOnly; Secure",
      "orbit.dont_remember=1; Path=/; HttpOnly",
    ]
    expect(run(signIn, { hook })).toMatch(EPOCH)
    const signOut = run(["orbit.session_token=; Max-Age=0; Path=/; HttpOnly"], {
      hook,
      cookie: "orbit.session_token=t.sig",
    })
    expect(signOut).toMatch(EPOCH)
    expect(signOut).not.toContain("Max-Age")
    expect(warn).not.toHaveBeenCalled()
  })

  test("an app's ignoreCookies entry outranks the Better Auth suffix", () => {
    const hook = identityEpochHook({ ignoreCookies: ["legacy.session_token"] }, false)
    expect(run(["legacy.session_token=v; HttpOnly; Secure"], { hook })).toBeUndefined()
    const named = identityEpochHook(
      { identityCookies: ["x.session_token"], ignoreCookies: ["x.session_token"] },
      false,
    )
    expect(run(["x.session_token=v; HttpOnly; Secure"], { hook: named })).toMatch(EPOCH)
  })

  test("development reports an unknown HttpOnly cookie that changes, once per name", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {})
    const hook = identityEpochHook({}, true)
    expect(run(["sid=a; HttpOnly"], { hook })).toBeUndefined()
    run(["sid=b; HttpOnly"], { hook })
    run(["__Secure-sid=c; HttpOnly; Secure"], { hook })
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toStartWith("[nifra/web] NIFRA_KEEPALIVE_IDENTITY_COOKIE:")
    expect(message).toContain('identityCookies: ["sid"]')
    expect(message).toContain("ignoreCookies")
  })

  test("development stays quiet about readable, ignored, known and unchanged cookies", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {})
    const hook = identityEpochHook({ ignoreCookies: ["csrf"] }, true)
    run(["theme=dark"], { hook })
    run(["csrf=a; HttpOnly"], { hook })
    run(["better-auth.session_data=x; HttpOnly", "__nifra_draft=y; HttpOnly"], { hook })
    run(["sid=a; HttpOnly"], { hook, cookie: "sid=a" })
    run(["nifra_session=a; HttpOnly"], { hook })
    expect(warn).not.toHaveBeenCalled()
  })

  test("production never reports", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {})
    run(["sid=a; HttpOnly"], { hook: identityEpochHook({}, false) })
    expect(warn).not.toHaveBeenCalled()
  })

  test("a response without cookies is left alone", () => {
    expect(run([])).toBeUndefined()
    expect(run(["=nameless; HttpOnly"])).toBeUndefined()
  })
})

const adapter: RenderAdapter = {
  renderToStream: () => new Blob(["<p>page</p>"]).stream(),
  hydrationHead: () => "",
}
const manifestOf = (keepAlive: boolean) =>
  buildManifest(
    ["index.tsx"],
    () => async () => ({ default: () => null }),
    keepAlive ? { keepAlive: ["index.tsx"] } : {},
  )
const appOf = (keepAlive: boolean) =>
  createWebApp({
    adapter,
    clientEntry: "/c.js",
    manifest: manifestOf(keepAlive),
    keepAlive: { identityCookies: ["sid"] },
    use: (app) =>
      app
        .get("/login", (c) => {
          c.set.cookie("sid", "fresh", { maxAge: 300 })
          return "ok"
        })
        .get("/switch", (c) => {
          rotateIdentityEpoch(c)
          return "ok"
        })
        .get("/tracker", (c) => {
          c.set.cookie("tracker", "x", { httpOnly: true })
          return "ok"
        }),
  })

describe("createWebApp and the identity epoch", () => {
  test("an app with a keepAlive route rotates the epoch on a sign-in from any handler", async () => {
    const response = await appOf(true).fetch(new Request("https://app.test/login"))
    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    expect(cookies[1]).toMatch(EPOCH)
    expect(cookies[1]).toEndWith("; Max-Age=300")
  })

  test("it reports unknown cookies only when NODE_ENV says development or test", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {})
    const before = process.env.NODE_ENV
    const reports: Record<string, number> = {}
    try {
      for (const mode of ["development", "test", "production", undefined]) {
        if (mode === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = mode
        warn.mockClear()
        await appOf(true).fetch(new Request("https://app.test/tracker"))
        reports[mode ?? "unset"] = warn.mock.calls.length
      }
    } finally {
      if (before === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = before
    }
    expect(reports).toEqual({ development: 1, test: 1, production: 0, unset: 0 })
  })

  test("an app without one adds nothing", async () => {
    const response = await appOf(false).fetch(new Request("https://app.test/login"))
    expect(response.headers.getSetCookie()).toHaveLength(1)
  })

  test("rotateIdentityEpoch sets a readable epoch from a custom flow", async () => {
    for (const [url, pattern] of [
      [
        "https://app.test/switch",
        /^__Host-nifra-epoch=[0-9a-f]{32}; Path=\/; Secure; SameSite=Lax$/,
      ],
      ["http://localhost/switch", /^nifra-epoch=[0-9a-f]{32}; Path=\/; SameSite=Lax$/],
    ] as const) {
      const response = await appOf(false).fetch(new Request(url))
      const cookies = response.headers.getSetCookie()
      expect(cookies).toHaveLength(1)
      expect(cookies[0]).toMatch(pattern)
      expect(cookies[0]).not.toContain("HttpOnly")
    }
  })

  test("rotateIdentityEpoch keeps the prefixed epoch behind a TLS proxy that forwards nothing", async () => {
    const response = await appOf(false).fetch(
      new Request("http://app.internal/switch", {
        headers: { cookie: "__Host-nifra-epoch=0123456789abcdef0123456789abcdef" },
      }),
    )
    expect(response.headers.getSetCookie()[0]).toMatch(
      /^__Host-nifra-epoch=[0-9a-f]{32}; Path=\/; Secure; SameSite=Lax$/,
    )
  })
})
