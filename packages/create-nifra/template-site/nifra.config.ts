// The nifra CLI's config — read by `nifra dev|build|start`. Separate from `framework.ts` (which the
// edge/server entries import, so it must stay edge-bundlable): THIS file is imported only by the CLI
// (which runs on Bun), so it's the place for dev/build tooling like the Vite plugin. React JSX is
// Bun-native, so the only extra is the Vite plugin for dev HMR (Fast Refresh).
import react from "@vitejs/plugin-react"

export { adapter } from "./framework"
export const clientModule = "@nifrajs/web-react/client"
export const vitePlugins = [react()]
