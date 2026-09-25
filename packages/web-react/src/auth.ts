/**
 * `@nifrajs/web-react/auth` - React bindings for `@nifrajs/authjs`. `<AuthSessionProvider>`
 * seeds the subtree with a session (from a loader on the server, refreshed in the browser) and
 * `useAuthSession()` reads it; `signIn`/`signOut` delegate to the shared client. Imports only
 * `react` + `@nifrajs/authjs/client`; no JSX (the package builds with plain `tsc`).
 */
import {
  type AuthClient,
  createAuthClient,
  type Session,
  type SignInOptions,
  type SignOutOptions,
} from "@nifrajs/authjs/client"
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"

export type { Session }
export type AuthStatus = "loading" | "authenticated" | "unauthenticated"

export interface AuthSession {
  readonly status: AuthStatus
  readonly session: Session | null
  /** Re-read the session from the server (after an out-of-band change, for example). */
  readonly refresh: () => Promise<void>
  readonly signIn: (providerId: string, options?: SignInOptions) => void
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

/** Provide the Auth.js session to the subtree. Memoized on client + seed; refresh re-reads. */
export function AuthSessionProvider(props: AuthSessionProviderProps): ReactNode {
  const client = useMemo(() => props.client ?? createAuthClient(), [props.client])
  const [status, setStatus] = useState<AuthStatus>(
    props.initialSession === undefined
      ? "loading"
      : props.initialSession === null
        ? "unauthenticated"
        : "authenticated",
  )
  const [session, setSession] = useState<Session | null>(props.initialSession ?? null)
  const refresh = useMemo(() => {
    return async (): Promise<void> => {
      try {
        const next = await client.getSession()
        setSession(next)
        setStatus(next === null ? "unauthenticated" : "authenticated")
      } catch {
        // A failed session read must fail closed as anonymous; leaving "loading" can strand the
        // subtree in an auth-pending state and make protected UI appear available by omission.
        setSession(null)
        setStatus("unauthenticated")
      }
    }
  }, [client])
  useEffect(() => {
    let live = true
    if (props.initialSession === undefined) {
      void client.getSession().then(
        (next) => {
          if (!live) return
          setSession(next)
          setStatus(next === null ? "unauthenticated" : "authenticated")
        },
        () => {
          // Treat an unavailable session endpoint as anonymous rather than keeping auth state
          // pending indefinitely or exposing stale authenticated UI.
          if (!live) return
          setSession(null)
          setStatus("unauthenticated")
        },
      )
    }
    return () => {
      live = false
    }
  }, [client, props.initialSession])
  const value = useMemo<AuthSession>(
    () => ({
      status,
      session,
      refresh,
      signIn: (providerId, options) => client.signIn(providerId, options),
      signOut: (options) => client.signOut(options),
    }),
    [status, session, refresh, client],
  )
  return createElement(AuthSessionContext.Provider, { value }, props.children)
}

/** Read the Auth.js session (`{ status, session }`). Throws if no `<AuthSessionProvider>` is above. */
export function useAuthSession(): AuthSession {
  const session = useContext(AuthSessionContext)
  if (session === null) {
    throw new Error(
      "[nifra/web-react] useAuthSession() must be used within an <AuthSessionProvider>",
    )
  }
  return session
}
