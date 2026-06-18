/**
 * The one place this app names its framework. The `nifra` CLI reads these conventional exports to wire
 * dev/build/start with zero config — swap them (and the routes) to change framework. React JSX is
 * Bun-native, so it needs no client/server Bun plugins; only the Vite plugin (dev HMR / Fast Refresh).
 */

import { reactAdapter } from "@nifrajs/web-react"
import react from "@vitejs/plugin-react"

export const adapter = reactAdapter
export const clientModule = "@nifrajs/web-react/client"
export const vitePlugins = [react()]
