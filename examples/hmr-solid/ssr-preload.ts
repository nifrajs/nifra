// Preloaded so dynamically-imported route `.tsx` files get Solid's SSR transform under Bun (Bun's
// native JSX would otherwise emit React-style output). The Vite dev server applies Solid's client
// transform + HMR (solid-refresh) separately via `vite-plugin-solid`.

import { solidBunPlugin } from "@nifrajs/web-solid"
import { plugin } from "bun"

plugin(solidBunPlugin("ssr"))
