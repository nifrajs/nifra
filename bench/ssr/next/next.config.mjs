// Standalone output → a self-contained Node server the runner serves on PORT. The page
// is force-dynamic (per-request SSR), not static. `outputFileTracingRoot` pins the trace
// root to THIS app (else Next infers the monorepo root and nests server.js under the full
// path); with it, the server lands predictably at .next/standalone/server.js.
export default {
  output: "standalone",
  outputFileTracingRoot: import.meta.dirname,
}
