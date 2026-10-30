import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.10.
 *
 * No import or dependency moves. Partial prerendering is stable, so `createWebApp` takes it as `ppr`
 * and the `ppr-option` source rewrite moves `experimental: { ppr }`. In-app links are typed: `navigate`,
 * `redirect` and React's `Link` take an `Href`, and the route table that types it replaces
 * `RouteSearch`. The query cache sends nothing to the browser unless the app names the queries, and
 * an identity change cancels a mutation still running; the notes say what an app sees differently.
 */
export const recipe: UpgradeRecipe = {
  version: "5.10.0",
  pins: [
    { match: "@nifrajs/", to: "5.10.0" },
    { match: "create-nifra", to: "5.10.0" },
    { match: "nifra", to: "5.10.0" },
  ],
  importMoves: [],
  sourceRewrites: ["ppr-option"],
  affects: [
    "@nifrajs/core",
    "@nifrajs/client",
    "@nifrajs/testing",
    "@nifrajs/web",
    "@nifrajs/web-react",
    "@nifrajs/web-preact",
    "@nifrajs/web-vue",
    "@nifrajs/web-svelte",
    "@nifrajs/web-solid",
    "@nifrajs/cli",
    "nifra",
  ],
  notes: [
    "Partial prerendering is stable: `createWebApp({ ppr: partialPrerendering(...) })` replaces `experimental: { ppr: partialPrerendering(...) }`, and the `experimental` option is removed. Passing it throws a `TypeError` that names `ppr`. The startup errors name `ppr.origin`, `ppr.deployment`, `ppr.store` and `ppr.storeSecret`. The `ppr-option` rewrite moves `experimental: { ppr }` in a `createWebApp` options literal; options with a spread, a second key under `experimental`, or an `experimental` built in another file are listed by line or left for you to check.",
    '`navigate()`, `redirect()` and the React `Link`, `NavLink` and `Navigate` take an `Href`, built by `href({ to, params, search, hash })` from `@nifrajs/web` (or an adapter\'s `/router` entry), or by `rawHref(path)` for a same-origin path built elsewhere. A string path, a template literal and the `{ to, search }` form of `navigate` are compile errors, so `tsc` lists each call: `navigate("/users/7")` becomes `navigate(href({ to: "/users/:id", params: { id: "7" } }))`, `redirect("/login")` becomes `redirect(href({ to: "/login" }))`, `<Link to="/pricing">` becomes `<Link to={href({ to: "/pricing" })}>`, and `navigate({ to, search, replace: true })` becomes `navigate(href({ to, search }), { replace: true })`. `redirect(url, { external: true })` is unchanged. `resolveNavigate`, `NavigateTargetInput` and `NavigateSearchOf` are removed from `@nifrajs/web`. `Link` and `NavLink` render the anchor without an `href`, and log a `console.error`, when `to` is not a same-origin path; `rawHref` throws a `TypeError` for one. `tsc` cannot see plain anchors, so search for `href="/` and ``href={`/``.',
    '`nifra dev`, `nifra build`, `nifra check` and `nifra types` write `.nifra/types/routes.d.ts`, which fills `RouteTable` with one `{ params, search }` entry per URL pattern, and `href()` reads it. A route file that imports no `./+types/...` module does not load it: `nifra check` warns when a source imports a navigation API and no program loads the table, and listing `.nifra/types/routes.d.ts` under `files` in tsconfig.json clears it. `RouteSearch`, `generateRouteSearchTypes`, `GenerateRouteSearchTypesOptions`, `nifra sync-routes` and the `nifra_sync_routes` MCP tool are removed: delete `nifra-routes.d.ts` and its tsconfig `include` entry, and move a hand-written `RouteSearch` entry to `RouteTable` as `"/path": { params: ...; search: ... }`. A route file whose name holds `#` or `?` is an error that names the file.',
    "`dehydrate()` on a query client sends nothing unless `shouldDehydrateQuery` selects the queries, where a bare call sent every successful query, regular and infinite. Every dehydrated value is serialized into the page and readable by the visitor. Pass `shouldDehydrateQuery` naming the keys that are safe to send, or `() => true` when every successful query in that client is meant for the browser. Without it the browser starts with no cache for those queries and fetches them itself, so a component that rendered their data on the server can differ from it on the first client render.",
    "A mutation still running when the visitor's identity changes, in this tab or another tab of the site, is cancelled: its `mutate` promise rejects with `MutationCancelledError`, and its `onSuccess`, `onError` and `onSettled` callbacks do not run. The mutation function takes a second argument, `{ signal }`, an `AbortSignal` that is aborted at that moment; pass it to `fetch` to stop the request. A call site that awaits `mutateAsync` across a sign-in or sign-out catches that error.",
    '`nifra check` reports NF-C056 (error) for `serverFunctions("todo", todos)` where `todos` is a namespace import of `todos.fn.ts`: the client stubs call the namespace the file names, so a mount under another word answers 404 on every call. Rename the mount, or put `// nifra-expect NF-C056: <reason>` above a call kept on purpose.',
    "Closing a modal route with Back shows the page kept under it as it was, and the route's loader is not called again for it, unless that page was loaded for a previous visitor or marked stale.",
    '`nifra check` reports NF-C057 (warn) for an `<a href="/path">` that no page, backend route or file in `public/` serves, and NF-C058 (info) for one that is a page today, with the `href()` call that replaces it. Neither fails a check unless `--strict` is set for the warning. Raise, lower or silence either with `rules` in `nifra.config`, or keep one link as written with `rawHref(path)` or `// nifra-expect NF-C058: <reason>` above the attribute.',
    "A path segment has one spelling in `getStaticPaths` output, the prerender report and written files, `enumerateStaticRoutes`, the typed client's path params and the requests `@nifrajs/testing` builds: characters outside `A-Za-z0-9 -._~!$&'()*+,:=@` are percent-encoded in upper-case hex, so `;`, `[`, `]` and `|` are escaped. A `getStaticPaths` entry that leaves out a param, or holds one no path can carry (`.`, `..`, a lone surrogate), is skipped, and the prerender report names the param. Adjacent route parameter values that the router would split differently are rejected, and translated pathnames refuse segments nested deeper than three percent-encodings.",
  ],
}
