---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-svelte": minor
"@nifrajs/web-vue": minor
"@nifrajs/cli": minor
"create-nifra": minor
---

Route hooks and links are typed from the route table. `useSearch(from)` on every adapter and `useParams(from)` (new on Preact, Solid, Svelte and Vue) take the route's pattern as an argument: `useSearch("/reports")`, `useParams("/users/:id")`. A pattern the table does not hold is a compile error, and an empty table (before `nifra types` has run) accepts any string with the loose types. The earlier forms are removed: `useSearch<typeof schema>()`, `useParams<{ id: string }>()` and the bare `useSearch()` / `useParams()`. `Route.ComponentProps` carries `search`, typed by the route's `searchSchema`, and the route table types the `searchSchema` of `.svelte` and `.vue` routes (visible to svelte-check and vue-tsc; a Vue page reads it with `useSearch`). `href()` takes the schema's input, so a field the schema defaults may be left out, and a route without params types `props.params` with no keys. `@nifrajs/web` exports `RouteFrom`, `ParamsOfFrom`, `SearchOfFrom`, `RouteTablePattern`, `RouteParamsOf`, `RouteSearchOf`, `RouteSearchInOf` and `SearchInputOf`.

`nifra check` adds NF-C059 (a hook that names another page's route) and NF-C060 (a cast to `Href`), and warns that the route table is outside the program when a file imports `useSearch` or `useParams`. `create-nifra` scaffolds `nifra.check.json` with NF-C057, NF-C059 and NF-C060 as errors, and the starter's route types match the generator.

`nifra upgrade 5.16.0 --write` rewrites the call shapes this release and the typed query keys and `formFor` retire, through three source rewrites on the syntax tree: `route-hooks` writes a page file's own route into `useSearch` and `useParams`, `query-keys` wraps the key of `getQueryData` and `setQueryData` in `queryKey(...)`, and `form-for` moves the path and method of `formFor<App, "/path">()` to `formFor<App>()("/path")`. A hook in a layout, a shared component or a `.svelte` or `.vue` file, and a `formFor` whose path is a type alias, are listed by line.
