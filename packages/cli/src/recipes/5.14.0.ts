import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.14.
 *
 * This release has no import or dependency moves. Its notes cover the new uWebSockets.js adapter,
 * the server-component tuple that moves to Vite 8.3.8, the markdown renderer behind `entry.html`,
 * and TRACE routing on Deno through a mounted app. A fifth covers `data:` URLs on a `<script>` in `@nifrajs/web-vanilla`.
 */
export const recipe: UpgradeRecipe = {
  version: "5.14.0",
  pins: [
    { match: "@nifrajs/", to: "5.14.0" },
    { match: "create-nifra", to: "5.14.0" },
    { match: "nifra", to: "5.14.0" },
  ],
  importMoves: [],
  affects: [
    "@nifrajs/content",
    "@nifrajs/core",
    "@nifrajs/node",
    "@nifrajs/node-uws",
    "@nifrajs/web",
    "@nifrajs/web-react",
    "@nifrajs/web-vanilla",
  ],
  notes: [
    "`@nifrajs/node-uws` serves an app on uWebSockets.js from Node, through the same node-direct lane as `@nifrajs/node`: `serve(app, { port })` from the new package. It has no WebSocket or static-file support, and uWebSockets.js is installed from GitHub with its own prebuilt binaries, so keep `@nifrajs/node` where those matter. Nothing changes for an app that stays on `@nifrajs/node`.",
    "The certified server-component tuple moves to Vite 8.3.8 and `@vitejs/plugin-rsc` 0.5.39. The pipeline's guard accepts only the certified Vite and the plugin peer is exact, so an app using server components must pin `vite@8.3.8` and `@vitejs/plugin-rsc@0.5.39` together. Apps that do not opt in to server components are unaffected.",
    "`entry.html` in `@nifrajs/content` is rendered by marked 18 (was 15): a code span that wraps across lines inside a list item stays one span, a single `~` before a number is text instead of strikethrough, and HTML blocks and tables no longer carry the blank lines that followed them in the source. Re-bake collections and review any snapshot of `entry.html`.",
    "On Deno with `normalizeTarget`, an app reached through `mount()` or `mountFetch()` routes a TRACE or TRACK request on the target its parent resolved, so `TRACE /x/../pages/form` answers the page's 405 with its `Allow` as on every other runtime.",
    "`@nifrajs/web-vanilla` writes an interpolated `data:` URL that begins a `<script>`'s `src` or `href` as `about:invalid`, as it already did for `javascript:`. A page that loads a script from an interpolated `data:` URL must serve it from a real URL; `data:` URLs on images, links, frames, objects and stylesheets are unchanged.",
  ],
}
