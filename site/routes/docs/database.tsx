import { pageMeta } from "../../meta"
import { CodeBlock } from "../../highlight"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Databases",
  "Nifra is database-agnostic: use SQLite, Postgres, or any ORM (Drizzle, Prisma, Kysely) from your handlers and loaders, on Bun, Node, Deno, and the edge.",
)

const SQLITE = `import { server } from "@nifrajs/core"
import { Database } from "bun:sqlite"        // Node: better-sqlite3 · edge: Turso/libSQL

// Open the connection ONCE at module scope (the driver pools internally).
const db = new Database("app.db")
const byId = db.query<{ id: number; name: string }>("SELECT * FROM users WHERE id = ?")

export const app = server().get("/users/:id", (c) =>
  // Parameterized (?) — never interpolate user input into SQL.
  byId.get(Number(c.params.id)) ?? new Response("Not found", { status: 404 }),
)`

const POSTGRES = `import { server } from "@nifrajs/core"
import { drizzle } from "drizzle-orm/postgres-js"   // or node-postgres / neon-http
import postgres from "postgres"
import { eq } from "drizzle-orm"
import { users } from "./schema"

const db = drizzle(postgres(process.env.DATABASE_URL!))

export const app = server().get("/users/:id", async (c) => {
  const [user] = await db.select().from(users).where(eq(users.id, Number(c.params.id)))
  return user ?? new Response("Not found", { status: 404 })
})`

const EDGE = `import { server } from "@nifrajs/core"

// On Workers there's no raw TCP, so use an HTTP-based driver. D1 is a typed platform binding:
interface Env { DB: D1Database }

const app = server<Env>().get("/users/:id", async (c) => {
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(c.params.id).first()
  return user ?? new Response("Not found", { status: 404 })
})`

const DRIZZLE = `// schema.ts — define your schema (source of truth)
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core"
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
})

// drizzle.config.ts — drizzle-kit config
import { defineConfig } from "drizzle-kit"
export default defineConfig({
  schema: "./schema.ts",
  out: "./migrations",
  dialect: "postgresql",
})

// db.ts — initialize and migrate
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { migrate } from "drizzle-orm/postgres-js/migrator"
const sql = postgres(process.env.DATABASE_URL!)
export const db = drizzle(sql, { schema: import("./schema") })
await migrate(db, { migrationsFolder: "./migrations" })  // on app start

// routes/users.ts — use your typed schema in a loader
import { type LoaderArgs } from "@nifrajs/web"
import { eq } from "drizzle-orm"
import { db } from "../db"
import { users } from "../db/schema"

export async function loader({ params }: LoaderArgs) {
  const [user] = await db.select().from(users).where(eq(users.id, Number(params.id)))
  return { user }
}
export default function UserPage({ data }: any) { return <h1>{data.user?.name}</h1> }`

const LOADER = `// In a full-stack app the same query runs in a route loader — typed end-to-end to the page.
export async function loader({ params }: LoaderArgs<typeof app>) {
  const post = await db.query("SELECT * FROM posts WHERE slug = ?").get(params.slug)
  if (!post) throw new Response("Not found", { status: 404 })
  return { post }
}`

const SCAFFOLD = `# Scaffold an app with the Drizzle layer already wired (schema, typed client, migrations, scripts, .env):
bun create nifra notes-api --db drizzle-libsql     # SQLite everywhere incl. the edge (or Turso)
bun create nifra notes-api --db drizzle-postgres   # Postgres (postgres.js) on Bun/Node/Deno
bun create nifra notes-api --db drizzle-sqlite     # Bun's built-in bun:sqlite, local file`

const DECORATE = `import { server } from "@nifrajs/core"
import { desc } from "drizzle-orm"
import { db, notes } from "./db"   // your Drizzle client + schema (what the scaffold generates)

// decorate() hangs the client on the context ONCE — every handler then reads it as \`c.db\`, fully typed.
export const app = server()
  .decorate("db", db)
  .get("/notes", async (c) => c.db.select().from(notes).orderBy(desc(notes.createdAt)))

export type App = typeof app`

const RLS = `// rls.ts — request-scoped Postgres RLS for Drizzle. Drizzle reuses pooled connections and won't carry
// a per-request setting, so each tenant query runs in a tx that first sets a GUC the RLS policy reads.
import { AsyncLocalStorage } from "node:async_hooks"
import { sql } from "drizzle-orm"
import { db, notes } from "./db"

const als = new AsyncLocalStorage<typeof db>()

// Bind every query inside fn() to userId. set_config(..., true) is LOCAL to the tx; \${userId} is a bound
// parameter (no SQL injection). One round-trip sets the GUC, then your queries run isolated.
export function scoped<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql\`select set_config('app.user_id', \${userId}, true)\`)
    return als.run(tx, fn)
  })
}

// Use this (not the raw db) inside scoped(). Throws if called unscoped — a missing scope is a loud error,
// never a silent cross-tenant read.
export function tenantDb(): typeof db {
  const tx = als.getStore()
  if (!tx) throw new Error("tenantDb() called outside scoped() — every tenant query must be scoped")
  return tx as typeof db
}

// route: bind to the session user — the DB then isolates every query in scope, even a buggy one.
app.get("/notes", (c) => scoped(c.session.userId, () => tenantDb().select().from(notes)))`

const RLS_SQL = `-- migration: enable RLS + a policy that reads the tx-local GUC set above.
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notes
  USING (user_id = current_setting('app.user_id', true)::uuid);`

export default function Database() {
  return (
    <div className="prose">
      <h1 className="page">Databases</h1>
      <p className="lead">
        Nifra's core bundles <b>no database layer</b>. Like Hono or Elysia, it owns the HTTP boundary —
        routing, validation, the typed client — and your handlers, loaders, and actions are just
        functions. Import any database client or ORM and call it there. SQLite, Postgres, MySQL,
        MongoDB, Drizzle, Prisma, Kysely — all work, because none of them are Nifra's concern.
      </p>

      <h2>Scaffold it (recommended)</h2>
      <p>
        You don't have to wire Drizzle by hand. <code>bun create Nifra</code> takes a{" "}
        <code>--db</code> flag and generates a correct, production-grade data layer — schema, typed
        client, <code>drizzle.config.ts</code>, the <code>db:generate</code>/<code>db:migrate</code>{" "}
        scripts, and <code>.env.example</code> — plus a Database section in the app's{" "}
        <code>AGENTS.md</code>, so a human <i>or a coding agent</i> starts from the right setup instead
        of inventing one.
      </p>
      <CodeBlock code={SCAFFOLD} />
      <p>
        <code>drizzle-libsql</code> is the default recommendation — it's the one SQLite client that runs
        on every runtime, including the edge (a local file in dev, <a href="https://turso.tech">Turso</a>{" "}
        in prod).
      </p>

      <h2>Inject the client once, read it as c.db</h2>
      <p>
        The whole integration is one seam: open the DB client once, <code>decorate</code> it onto the
        server, and every handler reads it as a typed <code>c.db</code>. This is how the scaffold wires
        it — and it keeps the client out of each handler's imports.
      </p>
      <CodeBlock code={DECORATE} />

      <h2>SQLite</h2>
      <p>
        <code>bun:sqlite</code> is built into Bun (zero install); use <code>better-sqlite3</code> on
        Node, or <code>libSQL</code>/Turso anywhere. Open the connection once and query from your
        routes:
      </p>
      <CodeBlock code={SQLITE} />

      <h2>Postgres with Drizzle (Recommended)</h2>
      <p>
        Drizzle gives you a **fully typed schema**, auto-generated SQL migrations, and a composable query
        builder. Define your schema once, run <code>bunx drizzle-kit generate</code> to create
        migrations, and Nifra's loaders use fully-typed queries:
      </p>
      <CodeBlock code={DRIZZLE} />
      <p>
        <b>Workflow:</b>
      </p>
      <ol>
        <li>
          Edit <code>schema.ts</code> — change a column name, add a table, whatever
        </li>
        <li>
          Run <code>bunx drizzle-kit generate</code> — Drizzle writes a new SQL migration to{" "}
          <code>migrations/</code>
        </li>
        <li>
          Call <code>migrate(db, {"{ migrationsFolder }"})</code> on app start — migrations run
          automatically, once each
        </li>
        <li>
          Your loaders use the typed schema; no manual table names or inference
        </li>
      </ol>

      <h2>Request-scoped multi-tenancy (Postgres RLS + Drizzle)</h2>
      <p>
        For multi-tenant data, enforce isolation at the <b>database</b>, not in every <code>WHERE</code>{" "}
        clause (one forgotten filter is a cross-tenant leak). Postgres Row-Level Security does it — but
        Drizzle reuses pooled connections and won't carry a per-request <code>SET</code>, so the trick is
        to run each tenant query inside a transaction that first sets a <b>transaction-local</b> GUC the
        policy reads. This <code>scoped()</code> + <code>tenantDb()</code> helper (≈30 lines) wires it up;{" "}
        <code>tenantDb()</code> <i>throws</i> when called unscoped, so a missing scope fails loudly instead
        of silently reading every tenant's rows.
      </p>
      <CodeBlock code={RLS} />
      <p>Enable RLS and the policy once, in a migration:</p>
      <CodeBlock code={RLS_SQL} />
      <p className="caveat">
        The policy is the source of truth; <code>scoped()</code> just supplies the identity. Pair it with a{" "}
        UUIDv7 <code>user_id</code> and an index on it. Connect <code>c.session.userId</code> from{" "}
        <a href="/docs/auth">@nifrajs/better-auth</a>.
      </p>

      <h2>Postgres (Raw Driver)</h2>
      <p>
        If you prefer parameterized queries over an ORM, use <code>postgres</code> or <code>pg</code>{" "}
        directly:
      </p>
      <CodeBlock code={POSTGRES} />

      <h2>In a loader</h2>
      <p>
        Full-stack? The same query goes in a route loader, and its result is typed straight into your
        page during SSR. The loader is server-only, so the database client is tree-shaken out of the
        browser bundle.
      </p>
      <CodeBlock code={LOADER} />

      <h2>Servers vs the edge</h2>
      <p>
        This is a <i>runtime</i> constraint, not a Nifra one — every edge framework shares it. On a
        long-running server you use native TCP drivers; on the edge (no raw sockets) you use HTTP /
        serverless drivers. The route code is identical either way.
      </p>
      <table>
        <thead>
          <tr>
            <th>Runtime</th>
            <th>SQLite</th>
            <th>Postgres / other</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Bun</td>
            <td>
              <code>bun:sqlite</code> (built-in)
            </td>
            <td>
              <code>postgres</code>, <code>pg</code>, Drizzle, Prisma
            </td>
          </tr>
          <tr>
            <td>Node</td>
            <td>
              <code>better-sqlite3</code>
            </td>
            <td>
              <code>postgres</code>, <code>pg</code>, Drizzle, Prisma
            </td>
          </tr>
          <tr>
            <td>Deno</td>
            <td>libSQL</td>
            <td>
              <code>postgres</code>, Drizzle
            </td>
          </tr>
          <tr className="hl">
            <td>Cloudflare / edge</td>
            <td>Cloudflare D1, Turso/libSQL</td>
            <td>Neon serverless, Postgres over Hyperdrive, Prisma Accelerate</td>
          </tr>
        </tbody>
      </table>
      <p>
        On Cloudflare, bindings like D1 are <b>typed</b> through <code>c.env</code> — see{" "}
        <a href="/docs/edge">Edge &amp; bindings</a>. For Workers MySQL/Postgres, Hyperdrive pools the
        connection so a native driver works over the binding.
      </p>

      <div className="caveat">
        <b>Security:</b> always parameterize (<code>?</code> / driver placeholders or an ORM) — never
        string-build SQL from request input. Nifra validates the request body/params at the boundary
        (with <code>t</code> or any Standard Schema), so malformed input is rejected before your query
        runs. See <a href="/docs/security">Security</a>.
      </div>
      <p>
        Complete runnable references — a typed CRUD API you can diff your own against:{" "}
        <code>examples/db-postgres</code> (Drizzle + Postgres, embedded PGlite — zero setup) and{" "}
        <code>examples/db-sqlite</code> (the same API on raw <code>bun:sqlite</code>, parameterized
        queries, boundary validation).
      </p>
    </div>
  )
}
