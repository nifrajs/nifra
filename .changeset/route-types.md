---
"@nifrajs/web": minor
"@nifrajs/client": minor
"@nifrajs/cli": minor
"create-nifra": patch
---

feat: generated route types

Every route file gets a generated `Route` namespace, imported from `./+types/<name>` by both halves
of the route:

```ts
// routes/blog/[slug].backend.ts
import type { Route } from "./+types/[slug]"
export const loaderOutput = t.object({ title: t.string() })
export async function loader({ api, params }: Route.LoaderArgs) { ... }

// routes/blog/[slug].tsx
import type { Route } from "./+types/[slug]"
export default function Post({ data, params }: Route.ComponentProps) { ... }
```

`Route.Params` comes from the path (`[id]`, optional `[[lang]]`, catch-all `[...path]`).
`Route.LoaderData` and `Route.ActionData` are the output types of `loaderOutput` and `actionOutput`,
so a component is typed with exactly what reaches it. `Route.LoaderArgs` types `api` from the app's
`backend/app.ts`, which `.nifra/types/register.d.ts` registers once with `@nifrajs/client`'s new
`Register` interface; no route imports the backend for its types.

`nifra types` writes the files to `.nifra/types` (and `--check` fails when one is stale); `nifra dev`,
`nifra build` and `nifra check` refresh them, and `nifra dev` keeps them current as routes are added
or removed. A route resolves `./+types/<name>` through `"rootDirs": [".", "./.nifra/types"]` in
tsconfig, which the scaffolded site and ISR apps now carry; `nifra types` says so when it is missing.
`@nifrajs/web/route-types` exports the generator.
