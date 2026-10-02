---
"@nifrajs/web": patch
---

`nifra build` no longer fails its development/production css parity check when a tool such as `wrangler pages dev`, Vercel or SvelteKit has left bundles in a dot-directory (`.wrangler`, `.vercel`, `.svelte-kit`) inside the app.
