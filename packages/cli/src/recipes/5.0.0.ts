import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.0.
 *
 * The runner pins the fixed group. Every changed default below has a `nifra check` finding or a
 * one-line way to keep the 4.x behavior, so the notes name both.
 */
export const recipe: UpgradeRecipe = {
  version: "5.0.0",
  pins: [
    { match: "@nifrajs/", to: "5.0.0" },
    { match: "create-nifra", to: "5.0.0" },
    { match: "nifra", to: "5.0.0" },
  ],
  importMoves: [],
  notes: [
    '`createWebApp` serves the backend over HTTP only at an `apiPrefix` the app sets; without one it is loader-only (`ctx.api`) and a browser call to `/api` reaches page routing. `nifra check` reports a `backend/framework.ts` that sets none (NF-C035); run `nifra fix --code NF-C035` to add `export const apiPrefix = "/api"` and keep the 4.x mount, or export `""` to keep the backend loader-only. A hand-written `createWebApp` call passes `apiPrefix: "/api"` itself.',
    "Root status pages (`_404.tsx`, `_<status>.tsx`) and `_error.tsx` render inside the layouts above them with their loader data, and a page rendered with layout data is `private, no-store`. A root status page that imports the root layout to wrap itself now renders it twice: `nifra check` reports it (NF-C034); remove the wrap. `export const inLayouts = false` renders a page the 4.x way and runs no layout loader for it.",
    "A WebSocket handshake runs the `authenticate()` stages, `derive`s and `beforeHandle`s registered before `app.ws()`, as an HTTP `GET` there does, so auth middleware now guards the sockets registered after it and refuses a handshake with the response it sends an HTTP request. Register a socket before the guard to keep it public. `nifra routes --hooks` lists what each socket runs.",
    "A Response returned to more than one request is no longer shared: a body-less one is copied for each request before cookies and headers are written, and one whose body was already sent answers `500`. Build a Response per request, or return data and let the handler serialize it.",
    "`invariants.executor` in `nifra.assurance.ts` is optional now that `invariants.setup` can provision the target, so code that reads the config's type handles a missing `executor`.",
  ],
}
