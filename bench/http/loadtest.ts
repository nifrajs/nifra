/**
 * Backwards-compatible alias for the full HTTP benchmark matrix.
 *
 * The canonical runner is `bench/http/run.ts`, powered by `oha` and covering Bun,
 * Node, and Deno sections. This file keeps older `bun run bench/http/loadtest.ts`
 * commands working without pulling the old autocannon dependency tree.
 */
await import("./run.ts")

export {}
