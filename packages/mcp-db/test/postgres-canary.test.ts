/**
 * The canary oracle for `@nifrajs/mcp-db/postgres`: plant a unique value in every place the
 * declaration hides (a masked column, excluded tables and partitions, materialized views over them,
 * a schema outside scope), generate queries over every read path from a seeded grammar, and check
 * two things that need no knowledge of any particular bypass:
 *
 *  - a query the grammar knows touches hidden data is refused, and every other one succeeds, so the
 *    generator is not just producing errors;
 *  - no successful result carries a canary, raw or in the encodings a query can apply.
 *
 * Gate: NIFRA_TEST_POSTGRES_URL, a superuser URL of a THROWAWAY server (see postgres-live.test.ts).
 * NIFRA_CANARY_SEED and NIFRA_CANARY_QUERIES vary the run; a failure prints the seed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { SQL } from "bun"
import { isDbRefusal } from "../src/engine.ts"
import {
  connectPostgres,
  explainPostgres,
  type PostgresClient,
  type PostgresQueryOptions,
  type PostgresTarget,
  parsePostgresUrl,
  postgresRoleSql,
  queryPostgres,
} from "../src/postgres.ts"
import { generate, KNOWN, mulberry32 } from "./fixtures/canary-grammar.ts"

const ADMIN_URL = process.env.NIFRA_TEST_POSTGRES_URL ?? ""
const SKIP = ADMIN_URL === ""
const SEED = Number(process.env.NIFRA_CANARY_SEED ?? 0x5eed)
const QUERIES = Number(process.env.NIFRA_CANARY_QUERIES ?? 400)
// bun test's 5 s default would close the clients mid-run: afterAll runs once a test times out.
const CASE_TIMEOUT_MS = 30_000 + QUERIES * 40

const run = `${process.pid}_${Date.now().toString(36)}`
const DB = `nifra_canary_${run}`
const PASSWORD = `canary-${crypto.randomUUID()}`
const ROLE = { granted: `nifra_canary_granted_${run}`, broad: `nifra_canary_broad_${run}` }
const SCOPE = { schemas: ["public"], exclude: ["secrets", "audit"] }
const masked = (name: string) => name === "password_hash"
const OPTIONS: PostgresQueryOptions = {
  ...SCOPE,
  timeoutMs: 5_000,
  maxRows: 50,
  maxResultBytes: 256 * 1024,
  redaction: { column: masked },
}

// Letters and digits only, so text search keeps each one a single lexeme.
const token = (place: string) => `cnry${place}${crypto.randomUUID().replaceAll("-", "")}`
const CANARY = {
  hash: token("hash"),
  secret: token("secret"),
  child: token("child"),
  audit: token("audit"),
  outside: token("outside"),
}
const CONTROL = token("control")

const md5 = (value: string) => createHash("md5").update(value).digest("hex")
const LEAK_FORMS = Object.values(CANARY).flatMap((value) => [
  value,
  value.toUpperCase(),
  [...value].reverse().join(""),
  Buffer.from(value).toString("hex"),
  Buffer.from(value).toString("base64").replace(/=+$/, ""),
  md5(value),
])

const REFUSED_FOR_READING = new Set([
  "NIFRA_DB_COLUMN_REFUSED",
  "NIFRA_DB_TABLE_EXCLUDED",
  "NIFRA_DB_FUNCTION_REFUSED",
])

let admin: PostgresTarget
const clients: PostgresClient[] = []

function rawClient(database: string): SQL {
  const options: SQL.PostgresOrMySQLOptions = {
    adapter: "postgres",
    hostname: admin.host ?? "127.0.0.1",
    port: admin.port,
    username: admin.username,
    database,
    max: 1,
  }
  if (admin.password !== undefined) options.password = admin.password
  return new SQL(options)
}

function engineClient(role?: string): PostgresClient {
  const base = { host: admin.host ?? "127.0.0.1", port: admin.port, database: DB }
  const password = role === undefined ? admin.password : PASSWORD
  const target: PostgresTarget = {
    ...base,
    username: role ?? admin.username,
    ...(password === undefined ? {} : { password }),
  }
  const client = connectPostgres(target, { timeoutMs: OPTIONS.timeoutMs })
  if (isDbRefusal(client)) throw new Error(client.message)
  clients.push(client)
  return client
}

const leakIn = (value: unknown): string | undefined => {
  const text = JSON.stringify(value)
  return LEAK_FORMS.find((form) => text.includes(form))
}

describe.skipIf(SKIP)(
  SKIP
    ? "postgres canary oracle (skipped: set NIFRA_TEST_POSTGRES_URL to a superuser URL of a throwaway server)"
    : "postgres canary oracle",
  () => {
    beforeAll(async () => {
      const parsed = parsePostgresUrl(ADMIN_URL)
      if (isDbRefusal(parsed)) throw new Error(`NIFRA_TEST_POSTGRES_URL: ${parsed.message}`)
      admin = parsed
      const server = rawClient(admin.database)
      try {
        const [version] = await server`SELECT current_setting('server_version_num')::int AS v`
        await server.unsafe(`CREATE DATABASE "${DB}"`)
        for (const role of Object.values(ROLE)) {
          await server.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${PASSWORD}'`)
        }
        if (Number(version?.v) >= 140000) {
          await server.unsafe(`GRANT pg_read_all_data TO "${ROLE.broad}"`)
        }
      } finally {
        await server.close()
      }
      const db = rawClient(DB)
      try {
        await db.unsafe(`
          CREATE TABLE orders (id serial PRIMARY KEY, status text, total int);
          CREATE TABLE users (id serial PRIMARY KEY, email text, password_hash text, note text);
          CREATE TABLE secrets (id serial PRIMARY KEY, value text);
          CREATE TABLE child_secret (extra int) INHERITS (secrets);
          CREATE TABLE audit (id int, memo text, at date NOT NULL) PARTITION BY RANGE (at);
          CREATE TABLE audit_2026 PARTITION OF audit FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
          CREATE SCHEMA outside;
          CREATE TABLE outside.notes (id int, body text);
          INSERT INTO orders (status, total) VALUES ('paid', 3), ('open', 5);
          INSERT INTO users (email, password_hash, note) VALUES ('a@example.com', '${CANARY.hash}', '${CONTROL}');
          INSERT INTO secrets (value) VALUES ('${CANARY.secret}');
          INSERT INTO child_secret (value, extra) VALUES ('${CANARY.child}', 1);
          INSERT INTO audit VALUES (1, '${CANARY.audit}', '2026-05-01');
          INSERT INTO outside.notes VALUES (1, '${CANARY.outside}');
          CREATE VIEW emails AS SELECT id, email FROM users;
          CREATE VIEW order_summary AS SELECT status, count(*) AS n FROM orders GROUP BY status;
          CREATE VIEW secret_view AS SELECT * FROM secrets;
          CREATE VIEW hash_view AS SELECT id, password_hash AS ph FROM users;
          CREATE MATERIALIZED VIEW secret_copy AS SELECT value FROM secrets;
          CREATE MATERIALIZED VIEW hash_copy AS SELECT id, password_hash AS ph FROM users;
          CREATE FUNCTION owner_hash(int) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
            AS $$ SELECT password_hash FROM users WHERE id = $1 $$;
          CREATE VIEW hash_lookup AS SELECT id, owner_hash(id) AS h FROM orders;
          REVOKE EXECUTE ON FUNCTION owner_hash(int) FROM PUBLIC;
          GRANT USAGE ON SCHEMA outside TO "${ROLE.granted}";
          GRANT SELECT ON outside.notes TO "${ROLE.granted}";
          ANALYZE;
        `)
      } finally {
        await db.close()
      }
      const role = await postgresRoleSql(engineClient(), {
        ...SCOPE,
        timeoutMs: OPTIONS.timeoutMs,
        role: ROLE.granted,
        redaction: { column: masked },
      })
      if (isDbRefusal(role)) throw new Error(role.message)
      const granting = rawClient(DB)
      try {
        for (const statement of role.statements) {
          if (statement.startsWith("--") || statement.startsWith("CREATE ROLE")) continue
          await granting.unsafe(statement)
        }
      } finally {
        await granting.close()
      }
    })

    afterAll(async () => {
      for (const client of clients) await client.close({ timeout: 0 }).catch(() => {})
      if (admin === undefined) return
      const server = rawClient(admin.database)
      try {
        await server.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`)
        for (const role of Object.values(ROLE)) {
          await server.unsafe(`DROP ROLE IF EXISTS "${role}"`)
        }
      } finally {
        await server.close()
      }
    })

    test(
      "the granted role: hidden reads are refused, clean ones answer, and no canary comes back",
      async () => {
        const granted = engineClient(ROLE.granted)
        const cases = [...KNOWN, ...generate(mulberry32(SEED), QUERIES)]
        const failures: Record<string, unknown>[] = []
        let controlSeen = false
        let previous = ""
        for (const [index, { sql, refuse }] of cases.entries()) {
          const outcomes: Awaited<ReturnType<typeof queryPostgres | typeof explainPostgres>>[] = [
            await queryPostgres(granted, sql, OPTIONS),
          ]
          if (index % 4 === 0)
            outcomes.push(await explainPostgres(granted, sql, { ...OPTIONS, analyze: true }))
          for (const outcome of outcomes) {
            const leaked = leakIn(outcome)
            if (leaked !== undefined) failures.push({ sql, leaked })
            if (isDbRefusal(outcome)) {
              if (outcome.code === "NIFRA_DB_DRIVER") {
                // A dead connection fails every later case: report the statement that preceded it.
                failures.push({ sql, after: previous, got: outcome.code, message: outcome.message })
                break
              }
              if (!refuse || !REFUSED_FOR_READING.has(outcome.code)) {
                failures.push({
                  sql,
                  expected: refuse ? "a read refusal" : "rows",
                  got: outcome.code,
                  message: outcome.message,
                })
              }
            } else {
              if (refuse) failures.push({ sql, expected: "a refusal", got: "an answer" })
              controlSeen ||= JSON.stringify(outcome).includes(CONTROL)
            }
          }
          if (failures.at(-1)?.got === "NIFRA_DB_DRIVER") break
          previous = sql
        }
        expect({ seed: SEED, failures }).toEqual({ seed: SEED, failures: [] })
        // The leak check can see a planted value: the visible control came back in some answer.
        expect(controlSeen).toBe(true)
        expect(cases.filter((entry) => entry.refuse).length).toBeGreaterThan(cases.length / 5)
        expect(cases.filter((entry) => !entry.refuse).length).toBeGreaterThan(cases.length / 5)
      },
      CASE_TIMEOUT_MS,
    )

    test(
      "a role that may read hidden data: every query is refused before it runs",
      async () => {
        const broad = engineClient(ROLE.broad)
        const failures: Record<string, unknown>[] = []
        for (const { sql } of [...KNOWN, ...generate(mulberry32(SEED + 1), 60)]) {
          const outcome = await queryPostgres(broad, sql, OPTIONS)
          if (!isDbRefusal(outcome) || outcome.code !== "NIFRA_DB_ROLE_GRANTS" || leakIn(outcome)) {
            failures.push({ sql, got: isDbRefusal(outcome) ? outcome.code : "an answer" })
          }
        }
        expect({ seed: SEED, failures }).toEqual({ seed: SEED, failures: [] })
      },
      CASE_TIMEOUT_MS,
    )
  },
)
