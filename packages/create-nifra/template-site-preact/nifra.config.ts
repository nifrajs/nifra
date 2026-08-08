// The nifra CLI's config - read by `nifra dev|build|start`. Separate from `framework.ts` (which the
// edge/server entries import, so it must stay edge-bundlable): THIS file is imported only by the CLI
// (which runs on Bun), so it's the place for CLI-only build/dev tooling. Preact JSX is Bun-native,
// so the default dev loop needs no Vite plugin.

export { adapter } from "./framework"
export const clientModule = "@nifrajs/web-preact/client"
