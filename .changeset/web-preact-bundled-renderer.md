---
"@nifrajs/web-preact": patch
---

A bundled Bun server renders with the renderer and `preact` inlined in the bundle. The adapter re-rooted `preact-render-to-string` to the app's `node_modules` whenever `Bun.resolveSync` existed, which a `target: "bun"` bundle keeps, so a server started from an installed app root loaded a second renderer and `preact` from disk and every page using a hook failed with a `__H` TypeError. Re-rooting now stays off under the build's `NIFRA_SSR_BUNDLED` marker and inside any bundle, as in the React adapter; the unbundled Bun runtime still re-roots.
