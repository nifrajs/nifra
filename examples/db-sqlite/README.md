# db-sqlite

nifra used as a **pure backend** with a real database — a typed todos API on `bun:sqlite`.

It shows the pattern that's identical for any database: open one connection at module scope, run
**parameterized** queries from your handlers, and let nifra validate input at the HTTP boundary. There's
no frontend here — this is nifra in the same role as Hono or Elysia.

```sh
bun run examples/db-sqlite/server.ts
curl localhost:3000/todos
curl -X POST localhost:3000/todos -H 'content-type: application/json' -d '{"text":"buy milk"}'
```

- `db.ts` — the SQLite connection, schema, and prepared, parameterized statements (typed via `<Todo>`).
- `backend.ts` — the `server()` routes; `POST /todos` validates `text` (1–500 chars) before it touches the DB.
- `server.ts` — Bun's default-export server (`{ port, fetch }`).

**Other databases / runtimes** (the route code is unchanged):

| Runtime | Use |
| --- | --- |
| Bun | `bun:sqlite` (built-in), `postgres`, `pg`, Drizzle, Prisma |
| Node | `better-sqlite3`, `pg`, `postgres`, Drizzle, Prisma |
| Deno | `postgres`, libSQL, Drizzle |
| Cloudflare / edge | Cloudflare **D1** (typed via `c.env.DB`), **Neon** serverless, **Turso/libSQL**, Postgres over **Hyperdrive** — HTTP drivers, since the edge has no raw TCP |
