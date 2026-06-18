/**
 * SQLite-backed todos API (nifra as a pure backend).
 *
 *   bun run examples/db-sqlite/server.ts
 *   curl localhost:3000/todos
 *   curl -X POST localhost:3000/todos -H 'content-type: application/json' -d '{"text":"buy milk"}'
 *   curl -X POST localhost:3000/todos/1/toggle
 *   curl -X DELETE localhost:3000/todos/1
 */
import { app } from "./backend"

export default { port: Number(Bun.env.PORT ?? 3000), fetch: app.fetch }
