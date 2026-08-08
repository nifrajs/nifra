---
"@nifrajs/web": minor
"@nifrajs/web-solid": patch
"@nifrajs/web-svelte": patch
"@nifrajs/web-vue": patch
---

SSR renders the code that is on disk on the Bun dev pipeline, not just for route files. An edit to anything a route imports - a component, a helper, a `*.server` module, at any depth - now reaches the server-rendered HTML on the next request, so a saved change no longer shows up on the client while the SSR pass still renders the version the server started with. All four frameworks, and both `import "./Counter"` and `import "./Counter.tsx"`.

A module nobody edited keeps its identity, so a database client or any other module-scope singleton shared between the backend and a route is still a single instance; editing that module deliberately gives the routes the new code. The Vite pipeline is unchanged - it already owned an SSR module graph.

`@nifrajs/web/plugins/kit` adds `rewriteSsrImports`, which a plugin that compiles its own file type passes its `generate: "ssr"` output through - the compiling plugin is the only code that sees that file's imports, so it is the only place they can be re-keyed.
