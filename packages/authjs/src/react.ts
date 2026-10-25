/**
 * `@nifrajs/authjs/react` - React bindings for the Auth.js client. `<AuthSessionProvider>` seeds the
 * subtree with a session (from a loader on the server, refreshed in the browser) and
 * `useAuthSession()` reads it; `signIn`/`signOut` delegate to the shared client. Imports only `react`
 * and the agnostic client; no JSX (the package builds with plain `tsc`). `react` is an optional peer.
 */

import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  type AuthClient,
  createAuthClient,
  type Session,
  type SignInOptions,
  type SignOutOptions,
} from "./client.ts"

export type { Session }
export type AuthStatus = "loading" | "authenticated" | "unauthenticated"

export interface AuthSession {
  readonly status: AuthStatus
  readonly session: Session | null
  /** Re-read the session from the server (after an out-of-band change, for example). */
  readonly refresh: () => Promise<void>
  readonly signIn: (providerId: string, options?: SignInOptions) => Promise<void>
  readonly signOut: (options?: SignOutOptions) => Promise<void>
}

const AuthSessionContext = createContext<AuthSession | null>(null)

export interface AuthSessionProviderProps {
  /** Shared client (base path, custom fetch). Default `createAuthClient()`. */
  readonly client?: AuthClient
  /** SSR seed from a loader (`await getSession(request, config)`). `undefined` (default) fetches
   * on mount instead - the subtree renders `loading` until it resolves. */
  readonly initialSession?: Session | null
  readonly children?: ReactNode
}

function seededStatus(seed: Session | null | undefined): AuthStatus {
  return seed === undefined ? "loading" : seed === null ? "unauthenticated" : "authenticated"
}

/** Provide the Auth.js session to the subtree. Memoized on client + seed; refresh re-reads. A new
 * `initialSession` (a loader re-run on navigation) replaces the session, as a remount would. */
export function AuthSessionProvider(props: AuthSessionProviderProps): ReactNode {
  const client = useMemo(() => props.client ?? createAuthClient(), [props.client])
  const [seed, setSeed] = useState(props.initialSession)
  const [status, setStatus] = useState<AuthStatus>(seededStatus(props.initialSession))
  const [session, setSession] = useState<Session | null>(props.initialSession ?? null)
  // A read applies only while it holds the latest generation; a newer read, a sign-out, a new client
  // or seed, and unmount each take one. The record is never replaced, so a sign-out that settles
  // after a client or seed change still clears the session the server ended.
  const reads = useRef({ generation: 0, signingOut: 0, live: true, client })
  if (reads.current.client !== client) {
    // A new client keeps what is shown (a parent may build one per render); only answers to the
    // previous client's reads are dropped.
    reads.current.client = client
    reads.current.generation++
  }
  if (seed !== props.initialSession) {
    reads.current.generation++
    // A render-phase update: React re-runs this component before any child sees the old session.
    setSeed(props.initialSession)
    setStatus(seededStatus(props.initialSession))
    setSession(props.initialSession ?? null)
  }
  const refresh = useMemo(() => {
    return async (): Promise<void> => {
      const state = reads.current
      // A read made while signing out could answer with the session being ended.
      if (state.signingOut > 0 || state.client !== client) return
      const generation = ++state.generation
      try {
        const next = await client.getSession()
        if (!state.live || state.generation !== generation) return
        setSession(next)
        setStatus(next === null ? "unauthenticated" : "authenticated")
      } catch {
        // A failed session read must fail closed as anonymous; leaving "loading" can strand the
        // subtree in an auth-pending state and make protected UI appear available by omission.
        if (!state.live || state.generation !== generation) return
        setSession(null)
        setStatus("unauthenticated")
      }
    }
  }, [client])
  useEffect(() => {
    const state = reads.current
    state.live = true
    if (props.initialSession === undefined) {
      void refresh()
    }
    return () => {
      state.live = false
      state.generation++
    }
  }, [refresh, props.initialSession])
  const value = useMemo<AuthSession>(
    () => ({
      status,
      session,
      refresh,
      signIn: (providerId, options) => client.signIn(providerId, options),
      signOut: async (options) => {
        const state = reads.current
        state.signingOut++
        state.generation++
        try {
          await client.signOut(options)
        } finally {
          state.signingOut--
          state.generation++
        }
        if (!state.live) return
        // The server ended the session: the subtree must not go on showing it, whether a redirect is
        // pending or `redirect: false` keeps the page.
        setSession(null)
        setStatus("unauthenticated")
      },
    }),
    [status, session, refresh, client],
  )
  return createElement(AuthSessionContext.Provider, { value }, props.children)
}

/** Read the Auth.js session (`{ status, session }`). Throws if no `<AuthSessionProvider>` is above. */
export function useAuthSession(): AuthSession {
  const session = useContext(AuthSessionContext)
  if (session === null) {
    throw new Error("[nifra/authjs] useAuthSession() must be used within an <AuthSessionProvider>")
  }
  return session
}
