// Preloaded so the dynamically-imported route `.svelte` files (+ the adapter's Chain/Router) get
// Svelte's SSR-generate compile under Bun — nifra SSRs via Bun import, which isn't `.svelte`-aware.
// The Vite dev server compiles `.svelte` for the *client* separately via @sveltejs/vite-plugin-svelte.

import { svelteBunPlugin } from "@nifrajs/web-svelte/plugin"
import { plugin } from "bun"

plugin(svelteBunPlugin("ssr"))
