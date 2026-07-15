/**
 * `--auth better-auth` — wire authentication into a scaffolded app, the same "bundle the right tool,
 * correctly" move as `--db`. nifra owns the *mount* (`@nifrajs/better-auth` plugs better-auth's handler
 * into a `server()` and gives typed `getSession`/`requireSession` guards); better-auth owns the auth
 * logic. Auth needs a database, so this composes with `--db`: the generated `auth.ts` reuses the client
 * from `./db` via better-auth's adapter for the chosen ORM (`drizzleAdapter` / `prismaAdapter`). The
 * agent then runs `bunx @better-auth/cli generate` to add the auth tables and migrates.
 *
 * `--auth` therefore requires `--db` (the CLI enforces it). better-auth's clean adapters cover Drizzle
 * and Prisma; Kysely is rejected (it has no drop-in adapter — wire better-auth's own dialect manually).
 * One preset today: `better-auth`.
 */

import { appendFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DB_PRESETS, type DbChoice, type Orm } from "./db.ts"

export const AUTH_CHOICES = ["better-auth"] as const
export type AuthChoice = (typeof AUTH_CHOICES)[number]

/** ORMs better-auth wires via a drop-in adapter. Kysely is excluded — see {@link assertAuthableDb}. */
const AUTHABLE_ORMS: ReadonlySet<Orm> = new Set<Orm>(["drizzle", "prisma"])

/**
 * Guard `--auth` against a DB whose ORM has no clean better-auth adapter. Throws an actionable error
 * for Kysely (passing a raw dialect to better-auth is manual wiring we won't fake-scaffold). Called by
 * the CLI before scaffolding so the failure is early and explains the fix.
 */
export function assertAuthableDb(db: DbChoice): void {
  const { orm } = DB_PRESETS[db]
  if (!AUTHABLE_ORMS.has(orm)) {
    throw new Error(
      `--auth better-auth doesn't scaffold for --db ${db} (${orm} has no drop-in better-auth adapter). ` +
        "Use a drizzle-* or prisma-* preset, or wire better-auth's database dialect manually in auth.ts.",
    )
  }
}

export interface AuthPreset {
  readonly label: string
  readonly note: string
  readonly deps: Readonly<Record<string, string>>
}

export const AUTH_PRESETS: Readonly<Record<AuthChoice, AuthPreset>> = {
  "better-auth": {
    label: "better-auth",
    note: "email/password + sessions, mounted at /api/auth/* — add OAuth providers in auth.ts.",
    // @nifrajs/better-auth mounts it; better-auth is the implementation (peer-installed alongside).
    deps: { "@nifrajs/better-auth": "^1.12.0", "better-auth": "^1.2.0" },
  },
}

/** The better-auth `database` adapter expression + its import line, for the scaffolded DB's ORM. */
function adapterFor(db: DbChoice): { importLine: string; database: string } {
  const { orm, dialect } = DB_PRESETS[db]
  if (orm === "prisma") {
    // Prisma's adapter `provider` is the datasource name ("postgresql"), not Drizzle's "pg".
    const provider = dialect === "postgres" ? "postgresql" : "sqlite"
    return {
      importLine: `import { prismaAdapter } from "better-auth/adapters/prisma"`,
      database: `prismaAdapter(db, { provider: "${provider}" })`,
    }
  }
  // Drizzle (the only other authable ORM; Kysely is rejected upstream by assertAuthableDb).
  const provider = dialect === "postgres" ? "pg" : "sqlite"
  return {
    importLine: `import { drizzleAdapter } from "better-auth/adapters/drizzle"`,
    database: `drizzleAdapter(db, { provider: "${provider}" })`,
  }
}

/** The generated `auth.ts` — a better-auth instance backed by the scaffolded DB client. */
function authModule(db: DbChoice): string {
  const { importLine, database } = adapterFor(db)
  return `import { betterAuth as createBetterAuth } from "better-auth"
${importLine}
import { db } from "./db"

// better-auth stores users + sessions in your database (the same one in db/). After editing the config
// (e.g. adding OAuth providers), generate its tables: \`bunx @better-auth/cli generate\` writes the auth
// schema for your ORM, then \`bun run db:migrate\` applies it.
export const auth = createBetterAuth({
  database: ${database},
  emailAndPassword: { enabled: true },
  // Set in .env — generate a strong value: openssl rand -base64 32
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
})

export type Auth = typeof auth
`
}

const ENV = `
# better-auth — REQUIRED. Generate a 32+ char secret: openssl rand -base64 32
BETTER_AUTH_SECRET="change-me-before-production"
BETTER_AUTH_URL="http://localhost:3000"
`

/** Write `auth.ts` and append the auth env vars to the (db-preset-created) `.env.example`. */
export async function writeAuthFiles(
  target: string,
  _auth: AuthChoice,
  db: DbChoice,
): Promise<void> {
  assertAuthableDb(db) // defensive: the CLI already checks, but never emit a broken adapter import
  await writeFile(join(target, "auth.ts"), authModule(db))
  // .env.example already exists (the DB preset wrote it; `--auth` requires `--db`); append, don't clobber.
  await appendFile(join(target, ".env.example"), ENV)
}
