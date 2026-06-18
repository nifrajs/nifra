/**
 * `@nifrajs/auth` — session primitives for nifra. Signed-cookie + server-store sessions, with the same
 * pluggable-store + prod-guard discipline as the ISR cache. **Bring your own identity** (Better Auth,
 * Lucia, your own OAuth/password logic); nifra owns the session cookie, store, CSRF, and route guards.
 */
export { type CsrfOptions, csrf } from "./csrf.ts"
export { type GuardOptions, requireSession, requireUser } from "./guards.ts"
export {
  createSessions,
  type Session,
  type SessionContext,
  type SessionCookieOptions,
  type SessionManager,
  type SessionOptions,
} from "./session.ts"
export {
  type KVNamespaceLike,
  KVSessionStore,
  MemorySessionStore,
  type MemorySessionStoreOptions,
  type SessionRecord,
  type SessionStore,
} from "./store.ts"
