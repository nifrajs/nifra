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
// The last render's effects, run by the test the way a client root commits them.
type Effect = () => undefined | (() => void)
const effects: Effect[] = []
const real = { ...React }
mock.module("react", () => ({
  ...real,
  useEffect: (effect: Effect) => {
    effects.push(effect)
  },
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

function render(
  initialSession: Session | null | undefined,
  authClient: AuthClient = client,
): ReturnType<typeof useAuthSession> {
  const props =
    initialSession === undefined ? { client: authClient } : { client: authClient, initialSession }
  for (let pass = 0; pass < 5; pass++) {
    cursor = 0
    rendering = true
    setDuringRender = false
    effects.length = 0
    renderToStaticMarkup(
      React.createElement(AuthSessionProvider, props, React.createElement(Capture)),
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

/** A fresh provider: no state from an earlier test. */
function reset(): void {
  cells.length = 0
  effects.length = 0
  seen = undefined
}

/** Commit the last render's effects, returning their cleanups. */
function commit(): Array<() => void> {
  return effects.flatMap((effect) => {
    const cleanup = effect()
    return cleanup === undefined ? [] : [cleanup]
  })
}

const ada: Session = { user: { name: "Ada" }, expires: "2999-01-01T00:00:00.000Z" }

test("with no initialSession the provider reads the session once mounted; a failed read is anonymous", async () => {
  const outcomes = [
    [async () => ada, { status: "authenticated", session: ada }],
    [
      async () => {
        throw new Error("session endpoint down")
      },
      { status: "unauthenticated", session: null },
    ],
  ] as const
  for (const [getSession, expected] of outcomes) {
    reset()
    const reading = { ...client, getSession }
    expect(render(undefined, reading)).toMatchObject({ status: "loading", session: null })
    commit()
    await Bun.sleep(0)
    expect(render(undefined, reading)).toMatchObject(expected)
  }
})

test("a provider unmounted before its session read settles ignores the answer", async () => {
  for (const settles of ["resolves", "rejects"] as const) {
    reset()
    let answer = (): void => {}
    const pending = {
      ...client,
      getSession: () =>
        new Promise<Session | null>((resolve, reject) => {
          answer = () => (settles === "resolves" ? resolve(ada) : reject(new Error("late")))
        }),
    }
    render(undefined, pending)
    for (const cleanup of commit()) cleanup()
    answer()
    await Bun.sleep(0)
    expect(render(undefined, pending)).toMatchObject({ status: "loading", session: null })
  }
})
