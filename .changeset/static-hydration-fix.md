---
"@nifrajs/web": minor
"@nifrajs/cli": patch
---

Fix `nifra build --target static` producing pages that render but never hydrate. The prerender pass hardcoded a placeholder client entry, but the real bundle is content-hashed — so the prerendered HTML's hydration `<script src>` 404'd and every control was inert. `BuildTargetOptions.prerenderApp` is now a factory `(client: BuildManifest) => app` invoked with the completed client build, so the emitted `<script src>` uses the real hashed entry (plus the same styles / route-preload the SSR targets use). A regression test asserts the static HTML references the emitted hashed entry and that the file exists under `/assets`. Breaking only for code calling `buildTarget("static", …)` directly (pass a factory instead of a prebuilt app); `nifra build --target static` users just get working hydration.
