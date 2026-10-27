---
"@nifrajs/cli": patch
"create-nifra": patch
"@nifrajs/web": patch
"@nifrajs/web-svelte": patch
"@nifrajs/mcp": patch
"@nifrajs/agent-review": patch
"@nifrajs/pi": patch
"@nifrajs/core": patch
---

`nifra check --sarif` and the command catalog's check output map report entries to diagnostics through one step. The CLI's page rules read the routes manifest and a `createWebApp` call's options through shared helpers, the layout migration applies its text edits through one function, two source scans share one route-registration reader, the two sync commands share their output schema and flag, and the Python and Go SDK generators share their setup and map-type reading.

`create-nifra` passes the flags it parsed to `scaffold` as they are.

`@nifrajs/web`'s PostCSS and Sass plugins build their JS module through one function, its client-build guards share one import-chain search, and a page route's failed loaders answer through one step.

`@nifrajs/web-svelte`'s Svelte and MDX plugins emit scoped CSS through the stylesheet emitter in `@nifrajs/web/plugins/kit`, as the other kit plugins do. The virtual stylesheet import they write is now `?nifra-svelte-css` (`?nifra-svelte-mdx-css` for MDX), and its resolved path stays slash-separated on Windows.

`@nifrajs/mcp` builds its capabilities once for `initialize` and `server/discover`. `@nifrajs/agent-review`'s composer uses the parser's outcome rule and evidence order, and the parser reads its two string lists through one reader. `@nifrajs/pi` reads message text through one helper, and core's evidence report sorts its findings through one comparator.
