---
"@nifrajs/web": minor
"@nifrajs/cli": minor
"create-nifra": minor
---

`nifra dev`, `nifra build`, `nifra check` and `nifra types` write `.nifra/types/routes.d.ts`, which fills `RouteTable` (exported from `@nifrajs/web`) with one `{ params, search }` entry per URL pattern. `params` comes from the compiled pattern, the function the router matches with, and `search` is the route's `searchSchema` output (the raw query when it declares none). An optional segment such as `[[lang]]` is two entries with exact params each, and `Route.Params` is read from the same patterns. Every generated `./+types` module references the table, so a program that imports any route's types loads it. `navigate({ to, search })` types `search` for every route, dynamic ones included. `Href` is exported as the type of a built in-app URL.

`nifra check` warns when a source file imports a navigation API (`Link`, `useNavigate`, `redirect` and the like) and no program loads the table; listing `.nifra/types/routes.d.ts` under `files` in tsconfig.json clears it. The starter's `.nifra/types` includes the table.

Upgrade: `RouteSearch`, `generateRouteSearchTypes` and `GenerateRouteSearchTypesOptions` are removed, and so is `nifra sync-routes` (with the `nifra_sync_routes` MCP tool). Delete `nifra-routes.d.ts` and its tsconfig `include` entry, and move any hand-written `RouteSearch` entry to `RouteTable` as `"/path": { params: ...; search: ... }`.
