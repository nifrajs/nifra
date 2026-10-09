---
"@nifrajs/web": patch
---

A server-components build exposes only `PUBLIC_*` values (or the configured `publicEnvPrefix`) from the app's `.env` files, like every other nifra build. It set no `envPrefix`, so Vite's default inlined every `VITE_*` value from `.env.production` into client code that read `import.meta.env`, a dependency included. The secret scan of every Vite build now also knows the values Vite loads from `.env.<mode>` files, not only the process environment, so a credential that exists only in one of those files fails the build if it reaches the bundle.
