import { afterAll, expect, mock, test } from "bun:test"
import type { AuthClient, Session } from "@nifrajs/authjs/client"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"

// A server render forgets state, so a prop change after mount cannot be seen there. Here state cells
// outlive each render the way a client root keeps them, and a render that sets state renders again,
// as React does for a render-phase update.
const cells: unknown[] = []
let cursor = 0
let rendering = false
let setDuringRender = false
const real = { ...React }
mock.module("react", () => ({
  ...real,
  useState: (initial: unknown) => {
    const index = cursor++
    if (!(index in cells)) cells[index] = typeof initial === "function" ? initial() : initial
    const set = (next: unknown): void => {
      cells[index] = typeof next === "function" ? next(cells[index]) : next
      if (rendering) setDuringRender = true
    }
    return [cells[index], set]
  },
}))
afterAll(() => {
  mock.module("react", () => real)
})

const { AuthSessionProvider, useAuthSession } = await import("../src/auth.ts")

const client: AuthClient = {
  getSession: async () => null,
  signIn: async () => {},
  signOut: async () => {},
}
let seen: ReturnType<typeof useAuthSession> | undefined
function Capture() {
  seen = useAuthSession()
  return null
}

function render(initialSession: Session | null): ReturnType<typeof useAuthSession> {
  for (let pass = 0; pass < 5; pass++) {
    cursor = 0
    rendering = true
    setDuringRender = false
    renderToStaticMarkup(
      React.createElement(
        AuthSessionProvider,
        { client, initialSession },
        React.createElement(Capture),
      ),
    )
    rendering = false
    if (!setDuringRender && seen !== undefined) return seen
  }
  throw new Error("the provider did not settle")
}

test("a new initialSession replaces the session; the same one keeps a later sign-out", async () => {
  const ada: Session = { user: { name: "Ada" }, expires: "2999-01-01T00:00:00.000Z" }
  const grace: Session = { user: { name: "Grace" }, expires: "2999-01-01T00:00:00.000Z" }

  expect(render(ada)).toMatchObject({ status: "authenticated", session: ada })
  expect(render(null)).toMatchObject({ status: "unauthenticated", session: null })
  const signedIn = render(grace)
  expect(signedIn).toMatchObject({ status: "authenticated", session: grace })

  await signedIn.signOut({ redirect: false })
  expect(render(grace)).toMatchObject({ status: "unauthenticated", session: null })
})
