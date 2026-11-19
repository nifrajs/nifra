import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.15.
 *
 * No import or dependency moves. The route hooks, the query cache's reads and writes, `serverFn` and
 * `formFor` are typed from the generated route table and the backend, which retires the old call shapes:
 * the `route-hooks`, `query-keys` and `form-for` source rewrites move the sites whose new form the call
 * decides, and `nifra upgrade` lists the rest by line. The runtime of every one is unchanged; what an
 * app sees is `tsc` failing on the old shapes.
 */
export const recipe: UpgradeRecipe = {
  version: "5.15.0",
  pins: [
    { match: "@nifrajs/", to: "5.15.0" },
    { match: "create-nifra", to: "5.15.0" },
    { match: "nifra", to: "5.15.0" },
  ],
  importMoves: [],
  sourceRewrites: ["route-hooks", "query-keys", "form-for"],
  affects: [
    "@nifrajs/cli",
    "@nifrajs/web",
    "@nifrajs/web-react",
    "@nifrajs/web-preact",
    "@nifrajs/web-solid",
    "@nifrajs/web-svelte",
    "@nifrajs/web-vue",
    "create-nifra",
  ],
  notes: [
    '`useSearch` and `useParams` take the route they read: `useSearch("/reports")` is that route\'s `searchSchema` output, `useParams("/users/:id")` its params, from `.nifra/types/routes.d.ts`. `useSearch<typeof searchSchema>()`, `useParams<{ id: string }>()` and the bare calls are removed, and `useParams` is new in `@nifrajs/web-preact`, `-solid`, `-svelte` and `-vue` (an accessor in Solid and Svelte, a ref in Vue). The argument is read only by the compiler; nothing changes at run time. The `route-hooks` rewrite writes the pattern of the page file the call is in; a call in a layout, a shared component or a `.svelte` or `.vue` file is listed by line, because only its author knows the route it renders in. A component shared by several pages takes the pattern as a prop typed as the union of their routes and passes it on. A pattern the table does not hold is a compile error, and `nifra check` warns (NF-C059) when a page names another page\'s route.',
    'A Vue page reads its search with `useSearch("/reports")`, not `defineProps<Route.ComponentProps>()`: `vue-tsc` accepts that type but `@vue/compiler-sfc` cannot resolve `./+types/<name>` or its conditional types, so the component does not compile. React, Preact, Solid and Svelte pages get `search` as a prop typed by `Route.ComponentProps`.',
    '`QueryClient.getQueryData` and `setQueryData` take a typed key: `queryKey<User>(["user", id])` carries the data type, and a plain array no longer compiles. `query`, `prefetchQuery`, `useQuery` and `createQuery` still take a plain key; given a typed one, its fetcher must return that type. The `query-keys` rewrite wraps the key at each call in a file that imports from `@nifrajs/web` (a file with a TanStack import is skipped) and moves a call\'s type argument onto the key: `qc.getQueryData<User>(KEY)` becomes `qc.getQueryData(queryKey<User>(KEY))`. A key shared by several calls reads better typed once where it is defined: `const USER = queryKey<User>(["user"])`, then `qc.getQueryData(USER)`.',
    "`serverFn` ties its result to its `output` schema: the caller's type is the schema's output, and the function must return what the schema accepts. A function that returns data without an `output` schema no longer compiles; it was already refused when the app started, so no app that ran is affected. Add the `output` schema, or return nothing.",
    "`formFor<App>()(path, method?)` replaces `formFor<App, Path, Method>()`: the path is checked against the app's routes, the method against the ones that route declares, and the handle carries the route's own `action` and `method` for `<form action={f.action} method={f.method}>`. The `form-for` rewrite moves a literal path and method from the type arguments to the call; a path or method written as a type alias is listed by line.",
    "A route with no params has `Route.Params` of `Record<never, never>`, so reading `props.params.anything` is a compile error (any key was accepted, typed `never`). `href({ to })` of a route with no params takes no `params`, and a search field the route's schema defaults may be left out of `href({ to, search })`. A `.svelte` or `.vue` route's `searchSchema` reaches the table under `svelte-check` and `vue-tsc`; plain `tsc` sees only the file's default export, and `.mdx` routes stay loosely typed.",
    "`nifra check` adds NF-C059 (a page's hook names another route) and NF-C060 (a value cast to `Href`, which skips the route check `href()` and `rawHref()` make), and warns when a source imports `useSearch` or `useParams` and no program loads the route table. `create-nifra` scaffolds a `nifra.check.json` that makes dead internal links (NF-C057), NF-C059 and NF-C060 errors; add the same `rules` to an existing app to hold them.",
    "After `nifra upgrade 5.15.0 --write`, run `nifra types` and then `tsc`: whatever the rewrites listed or left shows as a compile error at its line. The Linux or CI build needs `.nifra/types/routes.d.ts` generated before `tsc`, as it did for `href()`.",
  ],
}
