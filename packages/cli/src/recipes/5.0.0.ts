import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.0.
 *
 * The runner pins the fixed group and lists every retired `@nifra-gate-reviewed` comment. It never
 * writes the `nifra-expect` comment that replaces one: a reason it made up would silence a finding
 * nobody reviewed. Every changed default below has a `nifra check` finding or a one-line way to keep
 * the 4.x behavior, so the notes name both.
 */
export const recipe: UpgradeRecipe = {
  version: "5.0.0",
  pins: [
    { match: "@nifrajs/", to: "5.0.0" },
    { match: "create-nifra", to: "5.0.0" },
    { match: "nifra", to: "5.0.0" },
  ],
  importMoves: [],
  retiredMarkers: [
    {
      marker: "@nifra-gate-reviewed",
      instead: "// nifra-expect <code>: <reason>, with the code nifra check reports there",
    },
  ],
  notes: [
    "`@nifra-gate-reviewed` silences nothing. After review, silence one finding with `// nifra-expect <code>: <reason>` on its line or anywhere in the comment block above it. The upgrade lists every old comment and the line it covered; it never writes a reason. Every security finding and every error needs the reason, so `// nifra-expect route-overlap` (NF-C024, NF-C025) without one no longer silences the overlap.",
    "`nifra check` reports a secret comparison (NF-S002) as advisory only in browser code inside a nifra web app: a directory with `nifra.config.ts` or `backend/framework.ts`, or whose nearest package.json depends on `@nifrajs/web` or a `@nifrajs/web-*` adapter. The same comparison in `routes/` or `frontend/` of an API-only project, or of a package without a web dependency, fails the check.",
    "A WebSocket handshake runs the route chain an HTTP `GET` registered at the same point runs: `authenticate()`, auth middleware, `derive` and `beforeHandle` added before `app.ws()` guard the socket and can refuse the handshake with the response they send an HTTP request. Register a socket before the guard to keep it public. `nifra routes --hooks` lists what each socket runs.",
    '`createWebApp` serves the backend over HTTP only at an `apiPrefix` the app sets; without one it is loader-only (`ctx.api`) and a browser call to `/api` reaches page routing. `nifra check` reports a `backend/framework.ts` that sets none (NF-C035); run `nifra fix --code NF-C035` to add `export const apiPrefix = "/api"` and keep the 4.x mount, or export `""` to keep the backend loader-only. `nifra dev` loads `nifra.config.ts` when the app has one, so that file re-exports it: `export { apiPrefix } from "./backend/framework"` (the fix adds it). A hand-written `createWebApp` call passes `apiPrefix: "/api"` itself.',
    "Root status pages (`_404.tsx`, `_<status>.tsx`) and `_error.tsx` render inside the layouts above them with their loader data, and a page rendered with layout data is `private, no-store`. A root status page that imports the root layout to wrap itself now renders it twice: `nifra check` reports it (NF-C034); remove the wrap. `export const inLayouts = false` renders a page the 4.x way and runs no layout loader for it.",
    "A Response returned to more than one request is no longer shared: a body-less one is copied for each request before cookies and headers are written, and one whose body was already sent answers `500`. Build a Response per request, or return data and let the handler serialize it.",
    "`invariants.executor` in `nifra.assurance.ts` is optional now that `invariants.setup` can provision the target, so code that reads the config's type handles a missing `executor`.",
    "A layout's `meta` receives its own loader data as `data`, `null` when the layout has no loader; the page's data moved to `pageData`. A layout `meta` written against the page's data, such as a title template, reads `pageData` now: `({ pageData }) => ({ title: pageData.title })`. `nifra check` reports a layout with no loader whose `meta` reads `data` (NF-C040). A page's own `meta` is unchanged.",
  ],
}
