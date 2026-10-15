import { createSessions, MemorySessionStore, type SessionManager } from "@nifrajs/auth"

/** The session shape this app stores. nifra owns the *session*; a real app brings identity (Better
 * Auth / Lucia / its own password+OAuth) and just calls `session.set("userId", …)` after verifying. */
export interface SessionData extends Record<string, unknown> {
  userId: string
}

// LAZY on purpose. A route module (index.tsx) imports this for its loader, and that route is *also*
// bundled for the browser. If we called `createSessions(...)` at module top-level, that call is a
// side effect Bun can't tree-shake - so the store + `Bun.env` would leak into the client chunk and
// crash hydration. With only declarations here (no top-level call), the module is side-effect-free, so
// once the client strips the loader the whole import drops. Server-only singletons → lazy.
let manager: SessionManager<SessionData> | undefined
export const getSessions = (): SessionManager<SessionData> => {
  // Store mode (data server-side, revocable). Dev: in-memory store + secure:false for local http.
  // Production swaps in KVSessionStore(env.SESSIONS) + SESSION_SECRET (and drops secure). Without
  // SESSION_SECRET each process signs with a random secret: the in-memory store forgets sessions on
  // restart anyway, and no secret anyone can read ships with the example.
  manager ??= createSessions<SessionData>({
    secret:
      Bun.env.SESSION_SECRET ??
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
    store: new MemorySessionStore(),
    cookie: { secure: false },
  })
  return manager
}
