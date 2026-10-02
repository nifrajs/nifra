---
"create-nifra": patch
"@nifrajs/cli": patch
---

feat: starters type their routes with the generated `./+types`

The site and ISR starters type the landing page as `import type { Route } from "./+types/index"`:
`props: Route.ComponentProps` in the page, `Route.LoaderArgs` / `Route.ActionArgs` in its backend
half. `data` is the `loaderOutput` schema's type, which is what reaches the browser. A scaffold
ships its `.nifra/types`, so the types resolve right after `bun install`, before any nifra command
has run. The Svelte starter types its `$props()` the same way, and the Vue starter types the props it
declares from `Route`. Svelte and Vue scaffolds include their `.svelte` / `.vue` files in
`tsconfig.json`, so svelte-check, vue-tsc and the editor type-check routes. `nifra_frontend`'s
loader-typing guidance now points at the route types.
