import { afterAll, expect, mock, test } from "bun:test"
import type { AuthClient, Session } from "@nifrajs/authjs/client"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"

// This suite has no DOM renderer, and a server render never shows a later state change. So the
// provider's state updates are recorded where React hands out the setters, then passed through.
const updates: unknown[] = []
// A copy, taken before mocking: Bun updates the `React` namespace in place once the mock lands.
const real = { ...React }
mock.module("react", () => ({
  ...real,
  useState: <S>(initial: S | (() => S)) => {
    const [value, set] = real.useState(initial)
    const record = (next: React.SetStateAction<S>): void => {
      updates.push(next)
      set(next)
    }
    return [value, record]
  },
}))
afterAll(() => {
  mock.module("react", () => real)
})

const { AuthSessionProvider, useAuthSession } = await import("../src/auth.ts")

test("signing out with redirect: false leaves the subtree unauthenticated", async () => {
  const signedOut: unknown[] = []
  const client: AuthClient = {
    getSession: async () => null,
    signIn: async () => {},
    signOut: async (options) => {
      signedOut.push(options)
    },
  }
  const session: Session = { user: { name: "Ada" }, expires: "2999-01-01T00:00:00.000Z" }
  let signOut: ((options?: { redirect?: boolean }) => Promise<void>) | undefined
  function CaptureSignOut() {
    signOut = useAuthSession().signOut
    return null
  }
  renderToStaticMarkup(
    React.createElement(
      AuthSessionProvider,
      { client, initialSession: session },
      React.createElement(CaptureSignOut),
    ),
  )
  if (signOut === undefined) throw new Error("signOut was not captured")
  updates.length = 0
  await signOut({ redirect: false })
  expect(signedOut).toEqual([{ redirect: false }])
  expect(updates).toEqual([null, "unauthenticated"])
})

test("a sign-out the server refuses keeps the session", async () => {
  const client: AuthClient = {
    getSession: async () => null,
    signIn: async () => {},
    signOut: async () => {
      throw new Error("[nifra/authjs] signOut failed (HTTP 500)")
    },
  }
  let signOut: (() => Promise<void>) | undefined
  function CaptureSignOut() {
    signOut = useAuthSession().signOut
    return null
  }
  renderToStaticMarkup(
    React.createElement(
      AuthSessionProvider,
      { client, initialSession: null },
      React.createElement(CaptureSignOut),
    ),
  )
  if (signOut === undefined) throw new Error("signOut was not captured")
  updates.length = 0
  await expect(signOut()).rejects.toThrow("signOut failed")
  expect(updates).toEqual([])
})
