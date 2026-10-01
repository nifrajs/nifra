---
"@nifrajs/web-solid": major
"@nifrajs/web-svelte": major
"create-nifra": patch
---

The Solid and Svelte compiler plugins live on their `/plugin` subpaths, and each adapter root exports only the render adapter.

- `solidBunPlugin` is imported from `@nifrajs/web-solid/plugin`, matching `@nifrajs/web-svelte/plugin` and `@nifrajs/web-vue/plugin`.
- `@nifrajs/web-solid` and `@nifrajs/web-svelte` link no build-time or `node:` module, so a server or edge bundle that imports the adapter builds under edge resolve conditions (Cloudflare Workers, Vercel Edge, Deno).
- Solid site scaffolds import the plugin from the subpath.

Breaking: `solidBunPlugin` is no longer exported from `@nifrajs/web-solid`, nor `svelteBunPlugin` from `@nifrajs/web-svelte`. `nifra fix --code NF-C005` rewrites those imports.
