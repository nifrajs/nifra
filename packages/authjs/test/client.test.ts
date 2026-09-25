import { describe, expect, test } from "bun:test"
import { createAuthClient, signInUrl } from "../src/client.ts"

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

describe("signInUrl", () => {
  test("builds the provider URL with an encoded callback", () => {
    expect(signInUrl("github", { callbackUrl: "https://app.example.com/a?b=c" })).toBe(
      "/api/auth/signin/github?callbackUrl=https%3A%2F%2Fapp.example.com%2Fa%3Fb%3Dc",
    )
    expect(
      signInUrl("google", { basePath: "/auth", callbackUrl: "https://app.example.com/" }),
    ).toBe("/auth/signin/google?callbackUrl=https%3A%2F%2Fapp.example.com%2F")
  })
})

describe("createAuthClient", () => {
  test("getSession returns the session, null when anonymous or failing", async () => {
    const authed = createAuthClient({
      fetch: (async () =>
        json({ user: { name: "Ada" }, expires: "2999-01-01" })) as unknown as typeof fetch,
    })
    expect(await authed.getSession()).toEqual({ user: { name: "Ada" }, expires: "2999-01-01" })

    const anon = createAuthClient({
      fetch: (async () => json({})) as unknown as typeof fetch,
    })
    expect(await anon.getSession()).toBeNull()

    const down = createAuthClient({
      fetch: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    })
    expect(await down.getSession()).toBeNull()
  })

  test("signOut posts the CSRF token, then navigates unless told not to", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = []
    const stub = (async (url: string, init?: RequestInit) => {
      seen.push({ url: url.toString(), init })
      if (url.toString().endsWith("/csrf")) return json({ csrfToken: "tok" })
      return new Response("ok")
    }) as unknown as typeof fetch
    const navigated: string[] = []
    const loc = (globalThis as Record<string, unknown>).window
    ;(globalThis as Record<string, unknown>).window = {
      location: { href: "https://app.example.com/", assign: (url: string) => navigated.push(url) },
    }
    try {
      await createAuthClient({ fetch: stub }).signOut()
      expect(seen).toHaveLength(2)
      expect(seen[1]?.url).toBe("/api/auth/signout")
      expect(seen[1]?.init?.method).toBe("POST")
      expect(seen[1]?.init?.body?.toString()).toContain("csrfToken=tok")
      expect(navigated).toEqual(["/"])

      seen.length = 0
      navigated.length = 0
      await createAuthClient({ fetch: stub }).signOut({ callbackUrl: "/bye", redirect: false })
      expect(seen[1]?.init?.body?.toString()).toContain("callbackUrl=%2Fbye")
      expect(navigated).toEqual([])

      await createAuthClient({ fetch: stub }).signOut({ callbackUrl: "https://evil.example/" })
      expect(navigated).toEqual(["/"])
    } finally {
      if (loc === undefined) delete (globalThis as Record<string, unknown>).window
      else (globalThis as Record<string, unknown>).window = loc
    }
  })

  test("signOut without a CSRF token fails loud", async () => {
    const stub = (async (url: string) =>
      url.toString().endsWith("/csrf") ? json({}) : new Response("ok")) as typeof fetch
    await expect(createAuthClient({ fetch: stub }).signOut()).rejects.toThrow(/CSRF/)
  })

  test("signIn needs a browser page", () => {
    expect(() =>
      createAuthClient({
        fetch: (async () => json({})) as unknown as typeof fetch,
      }).signIn("github", { callbackUrl: "https://app.example.com/" }),
    ).toThrow(/browser/)
  })
})
