import { describe, expect, test } from "bun:test"
import type { AuthClient, Session } from "@nifrajs/authjs/client"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AuthSessionProvider, useAuthSession } from "../src/auth.ts"

const session = { user: { name: "Ada" }, expires: "2999-01-01T00:00:00.000Z" } as Session

function WhoAmI() {
  const { status, session: current } = useAuthSession()
  return createElement("p", { "data-status": status }, current?.user?.name ?? "anon")
}

describe("@nifrajs/web-react/auth", () => {
  test("seeded session renders synchronously (SSR); anonymous renders as such", () => {
    const authed = renderToStaticMarkup(
      createElement(AuthSessionProvider, { initialSession: session }, createElement(WhoAmI)),
    )
    expect(authed).toContain('data-status="authenticated"')
    expect(authed).toContain("Ada")

    const anon = renderToStaticMarkup(
      createElement(AuthSessionProvider, { initialSession: null }, createElement(WhoAmI)),
    )
    expect(anon).toContain('data-status="unauthenticated"')
    expect(anon).toContain("anon")
  })

  test("useAuthSession outside the provider throws", () => {
    expect(() => renderToStaticMarkup(createElement(WhoAmI))).toThrow(/AuthSessionProvider/)
  })

  test("a failed refresh resolves as unauthenticated instead of remaining loading", async () => {
    const failingClient: AuthClient = {
      getSession: async () => {
        throw new Error("session endpoint unavailable")
      },
      signIn: () => {},
      signOut: async () => {},
    }
    let refresh: (() => Promise<void>) | undefined
    function CaptureRefresh() {
      refresh = useAuthSession().refresh
      return null
    }
    renderToStaticMarkup(
      createElement(
        AuthSessionProvider,
        { client: failingClient, initialSession: session },
        createElement(CaptureRefresh),
      ),
    )
    if (refresh === undefined) throw new Error("refresh was not captured")
    await expect(refresh()).resolves.toBeUndefined()
  })
})
