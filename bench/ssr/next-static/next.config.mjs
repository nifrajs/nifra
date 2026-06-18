// Standalone Node server — same deploy shape as bench/ssr/next, but the index route is fully static
// (catalog baked at build). outputFileTracingRoot pins the trace root to THIS app.
export default {
  output: "standalone",
  outputFileTracingRoot: import.meta.dirname,
}
