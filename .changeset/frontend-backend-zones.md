---
"@nifrajs/web": major
---

feat(web)!: an app is split into zones, and the browser build admits only browser code

An app's files live in `routes/`, `frontend/`, `backend/`, `shared/` and `public/`. A route is two
files: `x.tsx` (or `.svelte`/`.vue`) is the page the browser receives, and `x.backend.ts` holds what
only the server runs - `loader`, `action`, `middleware`, `getStaticPaths`, `revalidate` and the other
server exports. `_layout.backend.ts` exports a directory's `middleware`; `_middleware.ts` is retired.

Every browser build and dev server - Bun and Vite - refuses `backend/`, a route's backend half, server
packages, and first-party code that belongs to no zone, naming the import chain that reached it.
After bundling, the build checks the finished module graph and every emitted file (code, CSS, assets
and source maps) and writes nothing it cannot trace to browser code. A workspace package declares its
side with `"nifra": { "environment": "frontend" | "backend" | "shared" | "library" }`.

Server builds hold the same rules from the other side: every first-party file belongs to a zone,
backend code never imports frontend code, and shared code imports only shared code and third-party
packages, never a server built-in. A server bundle also refuses a built-in its target cannot load: a
`node:` or `bun:` import kept in an edge worker, or a `bun:` import kept in a Node server. The Vite
server build runs the zone rules through `viteServerZoneGuard` from
`@nifrajs/web/plugins/vite-leak-guard`.

Browser code - a route's frontend half, `frontend/` and `shared/` - may read only `NODE_ENV`, the
bundler's `import.meta.env` flags (`MODE`, `DEV`, `PROD`, `SSR`, `BASE_URL`) and variables named with
the public prefix (`PUBLIC_` unless `publicEnvPrefix` says otherwise). Any other `process.env`,
`import.meta.env`, `Bun.env` or `Deno.env` read fails the build and the dev request, naming the
variable. Strings, comments, JSX text and Markdown code samples that mention a variable are not reads.

Removed: the `*.server` file convention, the `@nifrajs/web/plugins/vite-server-only` export and
`SERVER_ONLY_MODULE`. The opt-in marker import is `@nifrajs/web/backend-only`, its brand type is
`BackendOnly<T>`, and the dev diagnostics are `NIFRA_BACKEND_ONLY_IN_CLIENT` and
`NIFRA_BACKEND_IN_CLIENT`.
