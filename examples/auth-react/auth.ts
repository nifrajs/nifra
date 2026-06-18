import { createSessions, MemorySessionStore, type SessionManager } from "@nifrajs/auth"

/** The session shape this app stores. nifra owns the *session*; a real app brings identity (Better
 * Auth / Lucia / its own password+OAuth) and just calls `session.set("userId", …)` after verifying. */
export interface SessionData extends Record<string, unknown> {
  userId: string
}

// LAZY on purpose. A route module (index.tsx) imports this for its loader, and that route is *also*
// bundled for the browser. If we called `createSessions(...)` at module top-level, that call is a
// side effect Bun can't tree-shake — so the store + `Bun.env` would leak into the client chunk and
// crash hydration. With only declarations here (no top-level call), the module is side-effect-free, so
// once the client strips the loader the whole import drops. Server-only singletons → lazy.
let manager: SessionManager<SessionData> | undefined
export const getSessions = (): SessionManager<SessionData> => {
  // Store mode (data server-side, revocable). Dev: in-memory store + a dev secret + secure:false for
  // local http. Production swaps in KVSessionStore(env.SESSIONS) + a real secret (and drops secure).
  manager ??= createSessions<SessionData>({
    secret: Bun.env.SESSION_SECRET ?? "dev-secret-change-me-in-prod",
    store: new MemorySessionStore(),
    cookie: { secure: false },
  })
  return manager
}
