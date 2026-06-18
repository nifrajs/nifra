/**
 * `--db <preset>` — wire a Drizzle data layer into a freshly scaffolded app, so a human (or a coding
 * agent) starts from a correct, production-grade DB setup instead of inventing one. nifra ships NO DB
 * abstraction (that belongs to Drizzle/libSQL, not a web framework) — this just bundles the existing
 * tool, the Redwood-style "batteries available" move: a starter schema, a typed client, a migration
 * config, scripts, and env, all rip-out-able.
 *
 * Three presets, by runtime fit:
 *   - drizzle-libsql   — SQLite that runs EVERYWHERE incl. the edge (local file, or Turso). The default
 *                        cross-runtime answer.
 *   - drizzle-postgres — Postgres (postgres.js) on Bun/Node/Deno.
 *   - drizzle-sqlite   — Bun's built-in `bun:sqlite` (sync, local file). Bun-only.
 *
 * The starter `notes` table follows the production-grade DB defaults for its dialect; what a dialect
 * can't express inline (CHECK constraints, RLS, uuidv7) is called out in a comment, per those rules.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export const DB_CHOICES = [
  "drizzle-libsql",
  "drizzle-postgres",
  "drizzle-sqlite",
  "prisma-postgres",
  "prisma-sqlite",
  "kysely-postgres",
] as const
export type DbChoice = (typeof DB_CHOICES)[number]

/** ORM family of a preset — drives the auth adapter, the AGENTS DB rules, and the `c.db` query idiom. */
export type Orm = "drizzle" | "prisma" | "kysely"

export interface DbPreset {
  /** Human label for messages, e.g. "Drizzle + libSQL". */
  readonly label: string
  /** Which ORM/query-layer this preset wires (its query idiom + migration story differ). */
  readonly orm: Orm
  /** SQL dialect, for the auth adapter's `provider` mapping. */
  readonly dialect: "postgres" | "sqlite"
  /** One-line runtime-fit note (next-steps message + AGENTS.md). */
  readonly note: string
  readonly deps: Readonly<Record<string, string>>
  readonly devDeps: Readonly<Record<string, string>>
  readonly scripts: Readonly<Record<string, string>>
  /** Relative path → file contents to write into the scaffolded app. */
  readonly files: Readonly<Record<string, string>>
}

const DRIZZLE_ORM = "^0.38.3"
const DRIZZLE_KIT = "^0.30.4"
const SCRIPTS: Readonly<Record<string, string>> = {
  "db:generate": "drizzle-kit generate",
  "db:migrate": "drizzle-kit migrate",
  "db:studio": "drizzle-kit studio",
}

// --- starter schemas (one production-grade `notes` table per dialect) -------------------------------

const PG_SCHEMA = `import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

// Production-grade starter table. Postgres: UUID PK, TIMESTAMPTZ stamps, NOT NULL by default,
// soft-delete via deleted_at. Deferred to a migration (Drizzle can't express these inline; add them in
// the generated SQL): CHECK constraints (e.g. char_length(title) BETWEEN 1 AND 200), RLS for tenancy,
// and gen_uuidv7() for insert locality on hot tables (defaultRandom() = gen_random_uuid() for now).
export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
})

export type Note = typeof notes.$inferSelect
export type NewNote = typeof notes.$inferInsert
`

// SQLite has no UUID/TIMESTAMPTZ/RLS — so: text id (app-generated UUID), millisecond-epoch timestamps
// (timestamp_ms mode → JS Date), NOT NULL by default, soft-delete via deleted_at. Shared by the
// bun:sqlite and libSQL presets (same dialect). CHECK constraints are deferred to the migration.
const SQLITE_SCHEMA = `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

// Production-grade starter table (SQLite dialect — see the comment in your DB defaults for what the
// dialect can't enforce inline: CHECK constraints go in the generated migration).
export const notes = sqliteTable("notes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
})

export type Note = typeof notes.$inferSelect
export type NewNote = typeof notes.$inferInsert
`

// --- typed clients (export \`db\` + re-export the schema) --------------------------------------------
// Each prints the same usage header so an agent sees how to wire it (decorate) and query it.

const WIRE_DOC = `// Wire it into your backend ONCE, then read \`c.db\` in handlers:
//   import { server } from "@nifrajs/core"
//   import { db, notes } from "./db"
//   export const app = server().decorate("db", db)
//     .get("/notes", async (c) => c.db.select().from(notes))
// Never top-level-import this into a routes/ page file (server-only) — reach it via c.db / ctx.api.`

const PG_CLIENT = `import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema.ts"

${WIRE_DOC}

const url = process.env.DATABASE_URL
if (url === undefined || url === "") {
  throw new Error("DATABASE_URL is not set — copy .env.example to .env and fill it in.")
}

// One pooled client per process (per instance in a multi-instance deploy — fine for Postgres).
export const db = drizzle(postgres(url), { schema })
export * from "./schema.ts"
`

const SQLITE_CLIENT = `import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import * as schema from "./schema.ts"

${WIRE_DOC}

// Bun's built-in SQLite — sync + fast, local file. (Bun-only; for Node/Deno/edge use the libsql preset.)
export const db = drizzle(new Database(process.env.DATABASE_URL ?? "local.db"), { schema })
export * from "./schema.ts"
`

const LIBSQL_CLIENT = `import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import * as schema from "./schema.ts"

${WIRE_DOC}

// libSQL runs everywhere — a local file (file:local.db), a remote Turso URL (libsql://…) with an auth
// token, or an embedded replica. The one SQLite client that also works on the edge (Cloudflare Workers).
const token = process.env.DATABASE_AUTH_TOKEN
export const db = drizzle(
  createClient({
    url: process.env.DATABASE_URL ?? "file:local.db",
    ...(token !== undefined && token !== "" ? { authToken: token } : {}),
  }),
  { schema },
)
export * from "./schema.ts"
`

// --- drizzle-kit config (per dialect) ---------------------------------------------------------------

const PG_CONFIG = `import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  // biome-ignore lint/style/noNonNullAssertion: drizzle-kit reads this from .env (Bun auto-loads it).
  dbCredentials: { url: process.env.DATABASE_URL! },
})
`

const SQLITE_CONFIG = `import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "sqlite",
  dbCredentials: { url: process.env.DATABASE_URL ?? "local.db" },
})
`

const LIBSQL_CONFIG = `import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "turso",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "file:local.db",
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
})
`

// --- .env examples ----------------------------------------------------------------------------------

const PG_ENV = `# Postgres connection string (postgres.js). Never commit the real .env.
DATABASE_URL="postgres://user:password@localhost:5432/app"
`
const SQLITE_ENV = `# Path to the local SQLite file (Bun's bun:sqlite). Never commit the real .env.
DATABASE_URL="local.db"
`
const LIBSQL_ENV = `# Local file by default; point at Turso for a hosted/edge DB. Never commit the real .env.
DATABASE_URL="file:local.db"
# For Turso (or any remote libSQL):
# DATABASE_URL="libsql://your-db.turso.io"
# DATABASE_AUTH_TOKEN="your-token"
`

// --- Prisma presets ---------------------------------------------------------------------------------
// Prisma owns its schema DSL (prisma/schema.prisma), client codegen, and migration engine — so the
// scaffold is schema + a singleton client + the prisma scripts (no drizzle-kit equivalent needed).

const PRISMA_CLIENT_VERSION = "^6.5.0"
const PRISMA_SCRIPTS: Readonly<Record<string, string>> = {
  "db:generate": "prisma generate",
  "db:migrate": "prisma migrate dev",
  "db:studio": "prisma studio",
}

const PRISMA_PG_SCHEMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

// Production-grade starter model. Postgres: UUID PK, TIMESTAMPTZ stamps (@db.Timestamptz), NOT NULL by
// default, soft-delete via deletedAt. Add in a migration what the DSL can't express inline: CHECK
// constraints (e.g. length caps on title), RLS for tenancy, and gen_uuidv7() for insert locality on hot
// tables (uuid() = gen_random_uuid() for now).
model Note {
  id        String    @id @default(uuid()) @db.Uuid
  title     String
  body      String    @default("")
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt DateTime? @map("deleted_at") @db.Timestamptz(6)

  @@map("notes")
}
`

const PRISMA_SQLITE_SCHEMA = `datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

// Production-grade starter model (SQLite dialect — no native UUID/TIMESTAMPTZ/RLS; Prisma stores the
// String id + DateTime stamps for you). NOT NULL by default, soft-delete via deletedAt. CHECK
// constraints are deferred to the generated migration SQL.
model Note {
  id        String    @id @default(uuid())
  title     String
  body      String    @default("")
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")
  deletedAt DateTime? @map("deleted_at")

  @@map("notes")
}
`

const PRISMA_CLIENT = `import { PrismaClient } from "@prisma/client"

// Wire it into your backend ONCE, then read \`c.db\` in handlers:
//   import { server } from "@nifrajs/core"
//   import { db } from "./db"
//   export const app = server().decorate("db", db)
//     .get("/notes", async (c) => c.db.note.findMany({ where: { deletedAt: null } }))
// Never top-level-import this into a routes/ page file (server-only) — reach it via c.db / ctx.api.

// One PrismaClient per process. The globalThis guard stops dev hot-reload from opening a new connection
// pool on every reload (which exhausts the DB); production gets a single fresh instance.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }
export const db = globalForPrisma.prisma ?? new PrismaClient()
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db
`

const PRISMA_PG_ENV = `# Postgres connection string (Prisma). Never commit the real .env.
DATABASE_URL="postgresql://user:password@localhost:5432/app"
`
const PRISMA_SQLITE_ENV = `# Local SQLite file (Prisma). Never commit the real .env.
DATABASE_URL="file:./local.db"
`

// --- Kysely preset ----------------------------------------------------------------------------------
// Kysely is a typed query builder, not an ORM: you describe the DB shape (db/schema.ts) and own the
// migrations. It ships no CLI, so the scaffold includes a Migrator runner (db/migrate.ts) + a starter
// migration. Postgres via the official PostgresDialect + node-postgres.

const KYSELY_VERSION = "^0.27.4"
const KYSELY_SCRIPTS: Readonly<Record<string, string>> = {
  "db:migrate": "bun run db/migrate.ts",
}

const KYSELY_PG_SCHEMA = `import type { ColumnType, Generated } from "kysely"

// Kysely is types-only: describe the DB shape and keep it in sync with db/migrations (or generate it
// with \`kysely-codegen\`). There is no runtime schema object.
export interface NotesTable {
  id: Generated<string> // uuid PK, DB-defaulted (gen_random_uuid())
  title: string
  body: Generated<string> // defaults to ''
  // DB-managed stamps: never written by the app (never on insert/update), read back as Date.
  created_at: ColumnType<Date, never, never>
  updated_at: ColumnType<Date, never, Date>
  deleted_at: Date | null // soft delete
}

export interface DB {
  notes: NotesTable
}
`

const KYSELY_PG_CLIENT = `import { Kysely, PostgresDialect } from "kysely"
import { Pool } from "pg"
import type { DB } from "./schema.ts"

// Wire it into your backend ONCE, then read \`c.db\` in handlers:
//   import { server } from "@nifrajs/core"
//   import { db } from "./db"
//   export const app = server().decorate("db", db)
//     .get("/notes", async (c) =>
//       c.db.selectFrom("notes").selectAll().where("deleted_at", "is", null).execute())
// Never top-level-import this into a routes/ page file (server-only) — reach it via c.db / ctx.api.

const url = process.env.DATABASE_URL
if (url === undefined || url === "") {
  throw new Error("DATABASE_URL is not set — copy .env.example to .env and fill it in.")
}

// One pooled client per process (per instance in a multi-instance deploy — fine for Postgres).
export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }),
})
export type { DB } from "./schema.ts"
`

const KYSELY_MIGRATION = `import { type Kysely, sql } from "kysely"

// Production-grade starter table. Postgres: UUID PK (gen_random_uuid — swap to gen_uuidv7() for insert
// locality on hot tables once available), TIMESTAMPTZ stamps, NOT NULL by default, soft-delete via
// deleted_at. Add CHECK constraints (e.g. length caps) and RLS here per your DB defaults.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("notes")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql\`gen_random_uuid()\`))
    .addColumn("title", "text", (c) => c.notNull())
    .addColumn("body", "text", (c) => c.notNull().defaultTo(""))
    .addColumn("created_at", sql\`timestamptz\`, (c) => c.notNull().defaultTo(sql\`now()\`))
    .addColumn("updated_at", sql\`timestamptz\`, (c) => c.notNull().defaultTo(sql\`now()\`))
    .addColumn("deleted_at", sql\`timestamptz\`)
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("notes").execute()
}
`

const KYSELY_MIGRATE_RUNNER = `import { promises as fs } from "node:fs"
import * as path from "node:path"
import { FileMigrationProvider, Migrator } from "kysely"
import { db } from "./index.ts"

// Kysely ships no migration CLI, so this is the runner: it applies every pending migration in
// db/migrations (in filename order, each in its own transaction). Run with \`bun run db:migrate\`.
const migrator = new Migrator({
  db,
  provider: new FileMigrationProvider({
    fs,
    path,
    migrationFolder: path.join(import.meta.dir, "migrations"),
  }),
})

const { error, results } = await migrator.migrateToLatest()
for (const r of results ?? []) {
  console.log(r.status === "Success" ? \`✓ \${r.migrationName}\` : \`✗ \${r.migrationName}\`)
}
await db.destroy()
if (error !== undefined) {
  console.error("migration failed:", error)
  process.exit(1)
}
`

export const DB_PRESETS: Readonly<Record<DbChoice, DbPreset>> = {
  "drizzle-libsql": {
    label: "Drizzle + libSQL",
    orm: "drizzle",
    dialect: "sqlite",
    note: "libSQL runs on every runtime incl. the edge (local file or Turso).",
    deps: { "drizzle-orm": DRIZZLE_ORM, "@libsql/client": "^0.14.0" },
    devDeps: { "drizzle-kit": DRIZZLE_KIT },
    scripts: SCRIPTS,
    files: {
      "db/schema.ts": SQLITE_SCHEMA,
      "db/index.ts": LIBSQL_CLIENT,
      "drizzle.config.ts": LIBSQL_CONFIG,
      ".env.example": LIBSQL_ENV,
    },
  },
  "drizzle-postgres": {
    label: "Drizzle + Postgres",
    orm: "drizzle",
    dialect: "postgres",
    note: "Postgres (postgres.js) on Bun/Node/Deno — not the edge.",
    deps: { "drizzle-orm": DRIZZLE_ORM, postgres: "^3.4.5" },
    devDeps: { "drizzle-kit": DRIZZLE_KIT },
    scripts: SCRIPTS,
    files: {
      "db/schema.ts": PG_SCHEMA,
      "db/index.ts": PG_CLIENT,
      "drizzle.config.ts": PG_CONFIG,
      ".env.example": PG_ENV,
    },
  },
  "drizzle-sqlite": {
    label: "Drizzle + SQLite (bun:sqlite)",
    orm: "drizzle",
    dialect: "sqlite",
    note: "Bun's built-in SQLite — local file, Bun-only.",
    deps: { "drizzle-orm": DRIZZLE_ORM },
    devDeps: { "drizzle-kit": DRIZZLE_KIT },
    scripts: SCRIPTS,
    files: {
      "db/schema.ts": SQLITE_SCHEMA,
      "db/index.ts": SQLITE_CLIENT,
      "drizzle.config.ts": SQLITE_CONFIG,
      ".env.example": SQLITE_ENV,
    },
  },
  "prisma-postgres": {
    label: "Prisma + Postgres",
    orm: "prisma",
    dialect: "postgres",
    note: "Prisma ORM on Postgres (Bun/Node/Deno) — own schema DSL, migrate engine, and Studio.",
    deps: { "@prisma/client": PRISMA_CLIENT_VERSION },
    devDeps: { prisma: PRISMA_CLIENT_VERSION },
    scripts: PRISMA_SCRIPTS,
    files: {
      "prisma/schema.prisma": PRISMA_PG_SCHEMA,
      "db/index.ts": PRISMA_CLIENT,
      ".env.example": PRISMA_PG_ENV,
    },
  },
  "prisma-sqlite": {
    label: "Prisma + SQLite",
    orm: "prisma",
    dialect: "sqlite",
    note: "Prisma ORM on a local SQLite file — fastest start; migrate to Postgres later by swapping the datasource.",
    deps: { "@prisma/client": PRISMA_CLIENT_VERSION },
    devDeps: { prisma: PRISMA_CLIENT_VERSION },
    scripts: PRISMA_SCRIPTS,
    files: {
      "prisma/schema.prisma": PRISMA_SQLITE_SCHEMA,
      "db/index.ts": PRISMA_CLIENT,
      ".env.example": PRISMA_SQLITE_ENV,
    },
  },
  "kysely-postgres": {
    label: "Kysely + Postgres",
    orm: "kysely",
    dialect: "postgres",
    note: "Kysely typed query builder on Postgres (node-postgres) — you own the schema types + migrations.",
    deps: { kysely: KYSELY_VERSION, pg: "^8.13.1" },
    devDeps: { "@types/pg": "^8.11.10" },
    scripts: KYSELY_SCRIPTS,
    files: {
      "db/schema.ts": KYSELY_PG_SCHEMA,
      "db/index.ts": KYSELY_PG_CLIENT,
      "db/migrate.ts": KYSELY_MIGRATE_RUNNER,
      "db/migrations/0001_create_notes.ts": KYSELY_MIGRATION,
      ".env.example": PG_ENV,
    },
  },
}

const GITIGNORE_BLOCK = `
# database (added by --db)
.env
local.db
*.db-shm
*.db-wal
db/migrations/meta
`

/** Write a DB preset's files into `target` and ensure local DB artifacts + .env are gitignored. */
export async function writeDbFiles(target: string, choice: DbChoice): Promise<void> {
  const preset = DB_PRESETS[choice]
  for (const [rel, content] of Object.entries(preset.files)) {
    const path = join(target, rel)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  // Append DB ignores once (the template's .gitignore already exists post-rename; never clobber it).
  const gitignorePath = join(target, ".gitignore")
  let current = ""
  try {
    current = await readFile(gitignorePath, "utf8")
  } catch {
    // No .gitignore in this template — create one with just the DB block.
  }
  if (!current.includes("local.db")) {
    await writeFile(gitignorePath, `${current}${GITIGNORE_BLOCK}`)
  }
}
