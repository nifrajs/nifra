---
"@nifrajs/cli": minor
---

`nifra build` picks its bundler from your config instead of a fixed default, and `--bun` joins `--vite`.

The two phases default differently on purpose: `nifra dev` is Vite (for the plugin ecosystem, and because
Bun's dev-server bundler cannot compile CSS Modules), `nifra build` is Bun (faster, Bun-native). For an app
with no transforms that costs nothing - there is nothing for the two to disagree about. For an app whose
only transforms are `vitePlugins` it cost a class of production-only bug: those plugins ran in dev, and the
Bun build reads `clientPlugins`/`serverPlugins` and never `vitePlugins`, so it dropped them. The build
succeeded, the output looked plausible, and the transform had simply not happened.

That is the failure the pipeline-separation guard already refuses to allow - a plugin whose pipeline never
runs - reached by crossing phases instead of slots, where the slot check cannot see it because the plugins
are correctly placed.

So the default now follows the app. Vite plugins with no Bun counterpart means exactly one pipeline can
build it, and that is the one used; `nifra build` prints the reason so an auto-selected Vite build never
looks like you got the default. An app declaring both slots has supplied the Bun equivalent deliberately -
nothing is dropped - so the faster Bun default stands, unchanged. An app with no plugins is unaffected.

`--vite` and the new `--bun` force the choice, with one exception: `--bun` on an app whose only transforms
are `vitePlugins` is refused, naming the plugins it would discard, rather than producing the silently
incomplete build the flag would otherwise ask for. Passing both flags is an error.
