// Preloaded so the dynamically-imported route `.vue` files (+ the adapter's Router) get Vue's
// SSR-generate compile under Bun — nifra SSRs via Bun import, which isn't `.vue`-aware on its own.
// The Vite dev server compiles `.vue` for the *client* separately via `@vitejs/plugin-vue`.

import { vueBunPlugin } from "@nifrajs/web-vue/plugin"
import { plugin } from "bun"

plugin(vueBunPlugin("ssr"))
