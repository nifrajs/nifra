/**
 * Drizzle + Postgres todos API (nifra as a pure backend, embedded PGlite for zero-setup).
 *
 *   bun run examples/db-postgres/server.ts
 *   curl localhost:3000/todos
 *   curl -X POST localhost:3000/todos -H 'content-type: application/json' -d '{"text":"ship it"}'
 *
 * Regenerate migrations after editing schema.ts:  bunx drizzle-kit generate
 */
import { app } from "./backend"

export default { port: Number(Bun.env.PORT ?? 3000), fetch: app.fetch }
