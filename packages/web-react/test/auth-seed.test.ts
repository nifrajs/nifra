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
  useRef: (initial: unknown) => {
    const index = cursor++
    if (!(index in cells)) cells[index] = { current: initial }
    return cells[index]
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

test("refresh responses and errors started before sign-out cannot restore or overwrite state", async () => {
  for (const fails of [false, true]) {
    reset()
    let settle = (): void => {}
    const pending = {
      ...client,
      getSession: () =>
        new Promise<Session | null>((resolve, reject) => {
          settle = () => (fails ? reject(new Error("late")) : resolve(ada))
        }),
    }
    const value = render(ada, pending)
    const reading = value.refresh()
    await value.signOut({ redirect: false })
    settle()
    await reading
    expect(render(ada, pending)).toMatchObject({ status: "unauthenticated", session: null })
  }
})

test("a stale refresh is ignored after seed/client replacement or unmount", async () => {
  const grace: Session = { user: { name: "Grace" }, expires: ada.expires }
  for (const replacement of ["seed", "client", "unmount"] as const) {
    reset()
    let settle = (): void => {}
    const pending = {
      ...client,
      getSession: () =>
        new Promise<Session | null>((resolve) => {
          settle = () => resolve(ada)
        }),
    }
    const value = render(null, pending)
    const cleanups = commit()
    const reading = value.refresh()
    if (replacement === "seed") render(grace, pending)
    if (replacement === "client") render(null, client)
    if (replacement === "unmount") for (const cleanup of cleanups) cleanup()
    settle()
    await reading
    const next = render(
      replacement === "seed" ? grace : null,
      replacement === "client" ? client : pending,
    )
    expect(next).toMatchObject(
      replacement === "seed"
        ? { status: "authenticated", session: grace }
        : { status: "unauthenticated", session: null },
    )
  }
})

test("only the latest refresh can set the session", async () => {
  reset()
  const replies: Array<(session: Session | null) => void> = []
  const pending = {
    ...client,
    getSession: () => new Promise<Session | null>((resolve) => replies.push(resolve)),
  }
  const value = render(null, pending)
  const first = value.refresh()
  const second = value.refresh()
  replies[1]?.(null)
  await second
  replies[0]?.(ada)
  await first
  expect(render(null, pending)).toMatchObject({ status: "unauthenticated", session: null })
})

test("the initial read and refreshes during sign-out cannot restore authenticated UI", async () => {
  reset()
  let reads = 0
  let settleRead = (): void => {}
  let finishSignOut = (): void => {}
  const pending = {
    ...client,
    getSession: () => {
      reads++
      return new Promise<Session | null>((resolve) => {
        settleRead = () => resolve(ada)
      })
    },
    signOut: () =>
      new Promise<void>((resolve) => {
        finishSignOut = resolve
      }),
  }
  const value = render(undefined, pending)
  commit()
  const signingOut = value.signOut({ redirect: false })
  const refreshing = value.refresh()
  expect(reads).toBe(1)
  await refreshing
  finishSignOut()
  await signingOut
  settleRead()
  await Bun.sleep(0)
  expect(render(undefined, pending)).toMatchObject({ status: "unauthenticated", session: null })
})

// A parent that builds its client inline hands the provider a new object on every render.
test("a client rebuilt on every render keeps the shown session and a completed sign-out", async () => {
  const grace: Session = { user: { name: "Grace" }, expires: ada.expires }
  const rebuilt = (base: AuthClient): AuthClient => ({ ...base })

  reset()
  const reading = { ...client, getSession: async () => grace }
  await render(ada, reading).refresh()
  expect(render(ada, rebuilt(reading))).toMatchObject({ status: "authenticated", session: grace })

  reset()
  render(undefined, reading)
  commit()
  await Bun.sleep(0)
  expect(render(undefined, rebuilt(reading))).toMatchObject({ status: "authenticated" })

  reset()
  let finishSignOut = (): void => {}
  const slow = {
    ...client,
    signOut: () =>
      new Promise<void>((resolve) => {
        finishSignOut = resolve
      }),
  }
  const signingOut = render(ada, slow).signOut({ redirect: false })
  render(ada, rebuilt(slow))
  finishSignOut()
  await signingOut
  expect(render(ada, rebuilt(slow))).toMatchObject({ status: "unauthenticated", session: null })

  reset()
  await render(ada, client).signOut({ redirect: false })
  expect(render(ada, rebuilt(client))).toMatchObject({ status: "unauthenticated", session: null })
})

test("signIn goes through the provider's client", async () => {
  reset()
  const providers: string[] = []
  const recording = {
    ...client,
    signIn: async (providerId?: string) => {
      providers.push(providerId ?? "")
    },
  }
  await render(null, recording).signIn("github")
  expect(providers).toEqual(["github"])
})
