import { requireUser, type SessionManager } from "@nifrajs/auth"
import type { SessionData } from "../auth"

// Protected page. The session manager is injected as `ctx.api` (server.ts) - NOT imported here, since
// route modules are bundled for the browser and a server-only import would ship `Bun.env`/the store to
// the client. `requireUser` is browser-safe (it just builds a Response), so importing it is fine; it
// THROWS a 302 to /login when there's no session, and nifra returns the thrown Response - so an
// unauthenticated visit is redirected before any render. (Loaders read the request but can't write
// cookies; login/logout happen in the /api/* routes that have the full Context.)
export async function loader({ request, api }: { request: Request; api: unknown }) {
  // `api` is the SessionManager injected by createWebApp - a typed cast (not `any`), wired in server.ts.
  const sessions = api as SessionManager<SessionData>
  const session = await sessions.read(request)
  return { userId: requireUser(session, "userId", { redirectTo: "/login" }) }
}
