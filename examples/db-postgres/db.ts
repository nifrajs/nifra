import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { migrate } from "drizzle-orm/pglite/migrator"
import * as schema from "./schema"

// PGlite is real Postgres, embedded in-process — zero setup, so this example runs anywhere with no DB
// server. For PRODUCTION, swap these lines for a server connection; the schema, queries, and
// migrations are byte-identical:
//   import { drizzle } from "drizzle-orm/postgres-js"
//   import postgres from "postgres"
//   export const db = drizzle(postgres(process.env.DATABASE_URL!), { schema })
export const db = drizzle(new PGlite(), { schema })

let migrated: Promise<void> | undefined
/** Apply the `drizzle-kit`-generated SQL migrations once (idempotent). */
export const ready = (): Promise<void> => {
  migrated ??= migrate(db, { migrationsFolder: join(import.meta.dir, "migrations") })
  return migrated
}
