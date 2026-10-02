import { describe, expect, test } from "bun:test"
import { type DbRefusal, isDbRefusal } from "../src/engine.ts"
import {
  inReadOnlyTransaction,
  type PgConnection,
  type PgQuery,
  pgFailure,
  planDocument,
  planReads,
} from "../src/internal/pg-exec.ts"
import { lexPostgres, lintPostgres, withoutTerminator } from "../src/internal/pg-lexer.ts"
import {
  connectPostgres,
  explainPostgres,
  inspectPostgresRole,
  isLocalPostgresHost,
  lintPostgresStatement,
  type PostgresClient,
  type PostgresRoleReport,
  parsePostgresUrl,
  postgresHostRefusal,
  postgresRoleRefusal,
  postgresRoleSql,
  queryPostgres,
  readPostgresSchema,
} from "../src/postgres.ts"
import { HOSTILE_CORPUS } from "./fixtures/hostile-corpus.ts"

const code = (value: unknown): string | undefined => (isDbRefusal(value) ? value.code : undefined)

describe("parsePostgresUrl", () => {
  test("reads host, port, user, password, database and sslmode only", () => {
    expect(
      parsePostgresUrl(
        "postgres://app%40x:p%2Fw@127.0.0.1:6543/my%20db?sslmode=require&options=-c%20default_transaction_read_only%3Doff",
      ),
    ).toEqual({
      host: "127.0.0.1",
      port: 6543,
      username: "app@x",
      password: "p/w",
      database: "my db",
      tls: "require",
    })
    expect(parsePostgresUrl("postgresql://localhost")).toEqual({
      host: "localhost",
      port: 5432,
      username: "postgres",
      database: "postgres",
    })
    expect(parsePostgresUrl("postgres://[::1]:5433/app?user=u&password=p")).toEqual({
      host: "::1",
      port: 5433,
      username: "u",
      password: "p",
      database: "app",
    })
    expect(parsePostgresUrl("postgres://x@localhost?dbname=d&port=7000")).toMatchObject({
      port: 7000,
      database: "d",
      username: "x",
    })
  })

  test("a socket directory becomes the socket path", () => {
    expect(parsePostgresUrl("postgres:///app?host=/var/run/postgresql/")).toEqual({
      socket: "/var/run/postgresql/.s.PGSQL.5432",
      port: 5432,
      username: "postgres",
      database: "app",
    })
    expect(parsePostgresUrl("postgres:///app")).toMatchObject({ socket: "/tmp/.s.PGSQL.5432" })
  })

  test("malformed URLs are config refusals", () => {
    for (const url of [
      "not a url",
      "mysql://localhost/app",
      "postgres://a,b/app",
      "postgres://localhost/app?host=a,b",
      "postgres://localhost:0/app",
      "postgres://localhost/app?port=70000",
      "postgres://localhost/app?sslmode=sometimes",
    ]) {
      expect({ url, code: code(parsePostgresUrl(url)) }).toEqual({ url, code: "NIFRA_DB_CONFIG" })
    }
  })
})

describe("host gate", () => {
  test("loopback, *.localhost and sockets are local; anything else needs allowHosts", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "db.localhost",
      "127.0.0.1",
      "127.9.8.7",
      "::ffff:127.0.0.1",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
    ]) {
      expect({ host, local: isLocalPostgresHost(host) }).toEqual({ host, local: true })
    }
    for (const host of [
      "db.example.com",
      "10.0.0.5",
      "128.0.0.1",
      "127.0.0.256",
      "127.0.0.1.nip.io",
      "localhost.example.com",
      "::2",
    ]) {
      expect({ host, local: isLocalPostgresHost(host) }).toEqual({ host, local: false })
    }
    const remote = { host: "DB.example.com", port: 5432, username: "u", database: "d" }
    expect(code(postgresHostRefusal(remote))).toBe("NIFRA_DB_REMOTE_HOST")
    expect(postgresHostRefusal(remote, ["db.EXAMPLE.com"])).toBeUndefined()
    expect(
      postgresHostRefusal({
        port: 5432,
        username: "u",
        database: "d",
        socket: "/tmp/.s.PGSQL.5432",
      }),
    ).toBeUndefined()
    expect(code(connectPostgres(remote, { timeoutMs: 1000 }))).toBe("NIFRA_DB_REMOTE_HOST")
  })

  test("connectPostgres builds a client without connecting", async () => {
    const client = connectPostgres(
      {
        socket: "/tmp/nifra-none/.s.PGSQL.1",
        port: 1,
        username: "u",
        database: "d",
        tls: "disable",
      },
      { timeoutMs: 1500 },
    )
    expect(isDbRefusal(client)).toBe(false)
    if (!isDbRefusal(client)) await client.close({ timeout: 0 })
    const tcp = connectPostgres(
      { host: "127.0.0.1", port: 1, username: "u", password: "p", database: "d" },
      { timeoutMs: 100 },
    )
    if (isDbRefusal(tcp)) throw new Error(tcp.message)
    const unreachable = await queryPostgres(tcp, "SELECT 1", {
      timeoutMs: 100,
      maxRows: 1,
      maxResultBytes: 1024,
    })
    expect(code(unreachable)).toBe("NIFRA_DB_DRIVER")
    await tcp.close({ timeout: 0 })
  })
})

describe("tokenizer layer", () => {
  test("the hostile corpus entries the tokenizer owns are refused before the server", () => {
    // Statements whose Postgres refusal comes from the server or the plan pass the tokenizer.
    const serverOwned = new Set([
      "data-modifying CTE",
      "select into",
      "load_extension",
      "excluded table",
      "excluded through a view",
      "excluded through a CTE",
      "excluded in a WHERE subquery",
      "excluded in a scalar subquery",
      "excluded behind an exposed alias",
      "excluded, quoted",
      "CTE named after the excluded table it reads, schema-qualified",
      "excluded, schema-qualified",
      "excluded partition",
      "pg_class",
      "pg_stat_activity",
      "information_schema",
      "pg_shadow",
      "pg_settings",
      "pg_locks",
    ])
    for (const entry of HOSTILE_CORPUS) {
      if (entry.postgres === null) continue
      const linted = lintPostgresStatement(entry.sql)
      if (serverOwned.has(entry.name)) {
        expect({ name: entry.name, code: code(linted) }).toEqual({
          name: entry.name,
          code: undefined,
        })
      } else {
        expect({ name: entry.name, code: code(linted) }).toEqual({
          name: entry.name,
          code: entry.postgres,
        })
      }
    }
  })

  test("reads Postgres lexical forms without false refusals", () => {
    for (const sql of [
      "SELECT 1",
      "select 1;",
      "SELECT 1; -- trailing note",
      "(SELECT 1) UNION (SELECT 2)",
      "VALUES (1), (2)",
      "TABLE orders",
      "WITH t AS (SELECT 1) SELECT * FROM t",
      "SELECT 'it''s; DELETE', E'a\\'b;', $$x; DROP$$, $tag$ y; $ z $tag$, U&'d\\0061ta'",
      "SELECT B'1010', X'FF', N'text', \"quoted\"\"name\", 1.5e3, .5, 3abc",
      "SELECT /* outer /* nested; */ still comment */ 1",
      "SELECT substring('abc' FROM 1 FOR 2), $1::int",
      "SELECT format('for update')",
      "SELECT pg_catalog.lower('X')",
    ]) {
      expect({ sql, lint: lintPostgres(sql) }).toEqual({ sql, lint: undefined })
    }
  })

  test("refuses what it cannot read safely", () => {
    const message = (sql: string) => lintPostgres(sql)?.message
    expect(message("SELECT 'open")).toContain("unterminated")
    expect(message("SELECT $$open")).toContain("unterminated")
    expect(message("SELECT 1 /* open")).toContain("unterminated")
    expect(message('SELECT "open')).toContain("unterminated")
    expect(message("SELECT U&\"\\0070g_read_file\"('x')")).toContain("unicode-escaped")
    expect(message("")).toBe("empty query")
    expect(message("((")).toBe("empty query")
    expect(message("SELECT 1)")).toContain("closes a parenthesis")
    expect(message("SELECT (1")).toContain("leaves a parenthesis open")
    expect(message('"select" 1')).toContain("not SELECT")
    expect(message("SELECT * FROM t FOR KEY SHARE")).toContain("row-locking")
    expect(lintPostgres("SELECT dblink_connect('x')")).toMatchObject({
      kind: "function",
      name: "dblink_connect",
    })
  })

  test("lexes offsets, parameters and quoted words", () => {
    const { tokens } = lexPostgres('SELECT "A b", $2 FROM x')
    expect(tokens.map((token) => `${token.kind}:${token.value}:${token.offset}`)).toEqual([
      "word:SELECT:0",
      "word:A b:7",
      "punct:,:12",
      "param:$2:14",
      "word:FROM:17",
      "word:x:22",
    ])
  })

  test("withoutTerminator drops only a final semicolon", () => {
    expect(withoutTerminator("SELECT 1;")).toBe("SELECT 1")
    expect(withoutTerminator("SELECT 1; -- done")).toBe("SELECT 1")
    expect(withoutTerminator("SELECT ';'")).toBe("SELECT ';'")
    expect(withoutTerminator("")).toBe("")
  })
})

describe("pgFailure", () => {
  const fail = (errno: unknown, message = "x") =>
    pgFailure(Object.assign(new Error(message), { errno }))
  test("maps SQLSTATE classes to stable codes", () => {
    expect(fail("25006").code).toBe("NIFRA_DB_WRITE_REFUSED")
    expect(fail("25001").code).toBe("NIFRA_DB_WRITE_REFUSED")
    expect(
      fail("0A000", "DECLARE CURSOR must not contain data-modifying statements in WITH").code,
    ).toBe("NIFRA_DB_WRITE_REFUSED")
    expect(fail("0A000", "feature not supported").code).toBe("NIFRA_DB_QUERY_FAILED")
    expect(fail("42601", "cannot insert multiple commands into a prepared statement").code).toBe(
      "NIFRA_DB_WRITE_REFUSED",
    )
    expect(fail("42601", 'syntax error at or near "INSERT"').code).toBe("NIFRA_DB_WRITE_REFUSED")
    expect(fail("42601", "SELECT ... INTO is not allowed here").code).toBe("NIFRA_DB_WRITE_REFUSED")
    expect(fail("42601", 'syntax error at or near "FROMM"').code).toBe("NIFRA_DB_QUERY_FAILED")
    expect(fail("57014").code).toBe("NIFRA_DB_TIMEOUT")
    expect(fail("55P03").code).toBe("NIFRA_DB_TIMEOUT")
    expect(fail("25P03").code).toBe("NIFRA_DB_TIMEOUT")
    expect(fail("42501", "permission denied for table secrets").code).toBe(
      "NIFRA_DB_TABLE_EXCLUDED",
    )
    expect(fail("42501", "permission denied for function pg_read_file").code).toBe(
      "NIFRA_DB_FUNCTION_REFUSED",
    )
    for (const state of ["08006", "28P01", "3D000", "53300", "57P01", "XX000"]) {
      expect(fail(state).code).toBe("NIFRA_DB_DRIVER")
    }
    expect(fail("42883").code).toBe("NIFRA_DB_QUERY_FAILED")
    expect(fail(undefined).code).toBe("NIFRA_DB_DRIVER")
    expect(fail(61).code).toBe("NIFRA_DB_DRIVER")
    expect(pgFailure("plain", "ctx").message).toBe("ctx: plain")
  })
})

describe("plans", () => {
  test("planReads walks Plans, InitPlans and SubPlans, relations and functions", () => {
    const plan = [
      {
        Plan: {
          "Node Type": "Nested Loop",
          Plans: [
            { "Node Type": "Seq Scan", "Relation Name": "orders", Schema: "public" },
            {
              "Node Type": "Function Scan",
              "Function Name": "generate_series",
              Schema: "pg_catalog",
              Plans: [
                { "Relation Name": "secrets", Schema: "public", "Parent Relationship": "InitPlan" },
              ],
            },
            { "Relation Name": "orders", Schema: "public" },
            { "Relation Name": "nameless" },
          ],
        },
      },
    ]
    expect(planReads(plan)).toEqual({
      relations: [
        { schema: "public", name: "orders" },
        { schema: "public", name: "secrets" },
        { schema: "", name: "nameless" },
      ],
      functions: [{ schema: "pg_catalog", name: "generate_series" }],
    })
    let deep: unknown = { "Relation Name": "deep", Schema: "public" }
    for (let level = 0; level < 300; level++) deep = { Plan: deep }
    expect(planReads(deep).relations).toEqual([])
    expect(planDocument([{ "QUERY PLAN": '[{"Plan":{}}]' }])).toEqual([{ Plan: {} }])
    expect(planDocument([{ "QUERY PLAN": [{ Plan: {} }] }])).toEqual([{ Plan: {} }])
    expect(planDocument([])).toBeUndefined()
  })
})

const ROLE_ROW = {
  role: "reader",
  superuser: false,
  version: 180004,
  superuser_roles: [],
  server_roles: [],
  file_functions: [],
  extensions: [],
  languages: [],
}

describe("role gate", () => {
  const report = (patch: Partial<PostgresRoleReport>): PostgresRoleReport => ({
    role: "r",
    superuser: false,
    serverVersionNum: 180000,
    superuserRoles: [],
    serverRoles: [],
    fileFunctions: [],
    extensions: [],
    languages: [],
    ...patch,
  })
  test("superuser, inherited superuser, server roles, file functions, extensions, languages", () => {
    expect(postgresRoleRefusal(report({}))).toBeUndefined()
    expect(postgresRoleRefusal(report({ superuser: true }))?.code).toBe("NIFRA_DB_SUPERUSER")
    expect(postgresRoleRefusal(report({ superuserRoles: ["postgres"] }))?.message).toContain(
      "superuser role postgres",
    )
    expect(postgresRoleRefusal(report({ serverRoles: ["pg_read_server_files"] }))?.code).toBe(
      "NIFRA_DB_SUPERUSER",
    )
    expect(postgresRoleRefusal(report({ fileFunctions: ["lo_import"] }))?.code).toBe(
      "NIFRA_DB_SUPERUSER",
    )
    const ext = report({ extensions: ["dblink"], languages: ["plpython3u"] })
    expect(postgresRoleRefusal(ext)?.message).toContain("dblink, plpython3u")
    expect(postgresRoleRefusal(ext, { allowExtensions: ["DBLINK"] })?.message).not.toContain(
      "dblink",
    )
    expect(postgresRoleRefusal(ext, { allowExtensions: ["dblink", "plpython3u"] })).toBeUndefined()
  })
})

// A scripted stand-in for Bun.SQL: each statement is answered by the first matching rule.
type Answer = {
  rows?: readonly Record<string, unknown>[]
  values?: readonly (readonly unknown[])[]
}
type Rule = readonly [RegExp, Answer | ((values: unknown[]) => Answer)]

function fakeClient(rules: readonly Rule[], options: { reserveFails?: boolean } = {}) {
  const log: string[] = []
  const answer = (text: string, values: unknown[]): Answer => {
    log.push(text.trim().replace(/\s+/g, " "))
    for (const [pattern, reply] of rules) {
      if (pattern.test(text)) {
        if (typeof reply === "function") return reply(values)
        return reply
      }
    }
    return {}
  }
  const query = (text: string, values: unknown[]): PgQuery => {
    let settled: Promise<Answer> | undefined
    const run = () => {
      settled ??= Promise.resolve().then(() => answer(text, values))
      return settled
    }
    return {
      // biome-ignore lint/suspicious/noThenProperty: a PgQuery is awaitable by contract
      then: (onFulfilled, onRejected) =>
        run()
          .then((reply) => reply.rows ?? [])
          .then(onFulfilled, onRejected),
      values: () => run().then((reply) => reply.values ?? []),
    }
  }
  const connection = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    query(
      strings.reduce((text, part, index) => `${text}${index > 0 ? `$${index}` : ""}${part}`, ""),
      values,
    )) as PgConnection
  connection.unsafe = (text: string) => query(text, [])
  connection.release = () => {
    log.push("release")
  }
  const client: PostgresClient = {
    reserve: async () => {
      if (options.reserveFails === true)
        throw Object.assign(new Error("refused"), { errno: "08001" })
      return connection
    },
    close: async () => {},
  }
  return { client, log }
}

const fail = (errno: string, message: string) => () => {
  throw Object.assign(new Error(message), { errno })
}

const plan = (
  relations: readonly [string, string][],
  functions: readonly [string, string][] = [],
) => ({
  rows: [
    {
      "QUERY PLAN": [
        {
          Plan: {
            Plans: [
              ...relations.map(([schema, name]) => ({ "Relation Name": name, Schema: schema })),
              ...functions.map(([schema, name]) => ({ "Function Name": name, Schema: schema })),
            ],
          },
        },
      ],
    },
  ],
})

const QUERY = { timeoutMs: 2_000, maxRows: 2, maxResultBytes: 4096, exclude: ["secrets"] }

describe("query layers over a scripted client", () => {
  test("a query runs BEGIN READ ONLY, the role read, the cursor, the plan scope and one FETCH", async () => {
    const { client, log } = fakeClient([
      [/current_user::text AS role/, { rows: [ROLE_ROW] }],
      [/^EXPLAIN \(VERBOSE/, plan([["public", "orders"]])],
      [/WITH RECURSIVE planned/, { rows: [] }],
      [
        /^FETCH FORWARD 3 FROM nifra_c/,
        {
          values: [
            ['["id","id"]', 1n, 1n],
            ['["id","id"]', 2n, 2n],
            ['["id","id"]', 3n, 3n],
          ],
        },
      ],
    ])
    const rows = await queryPostgres(client, "  SELECT o.id, o.id FROM orders o;  ", QUERY)
    expect(rows).toEqual({
      columns: ["id", "id"],
      rows: [
        [1, 1],
        [2, 2],
      ],
      rowCount: 2,
      truncated: true,
      redactedColumns: [],
    })
    expect(log[0]).toBe(
      "BEGIN READ ONLY; SET LOCAL statement_timeout = 2000; SET LOCAL lock_timeout = 2000; SET LOCAL idle_in_transaction_session_timeout = 2000",
    )
    expect(log[2]).toStartWith(
      "DECLARE nifra_c NO SCROLL CURSOR FOR SELECT (SELECT json_agg(nifra_k)",
    )
    expect(log[2]).toContain("FROM ( SELECT o.id, o.id FROM orders o ) AS nifra_q")
    expect(log.slice(-2)).toEqual(["ROLLBACK", "release"])
    const empty = fakeClient([
      [/current_user::text AS role/, { rows: [ROLE_ROW] }],
      [/^EXPLAIN \(VERBOSE/, plan([])],
      [/^FETCH/, { values: [] }],
    ])
    expect(await queryPostgres(empty.client, "SELECT 1 WHERE false", QUERY)).toMatchObject({
      columns: [],
      rowCount: 0,
    })
    expect(empty.log.some((line) => line.includes("planned"))).toBe(false)
  })

  test("the plan scope refuses excluded, out-of-schema, inherited and system reads", async () => {
    const scoped = async (reads: Answer, ancestors: readonly Record<string, unknown>[] = []) => {
      const { client } = fakeClient([
        [/current_user::text AS role/, { rows: [ROLE_ROW] }],
        [/^EXPLAIN \(VERBOSE/, reads],
        [
          /WITH RECURSIVE planned/,
          (values) => {
            expect(values).toEqual([[{ schema: "public", name: "audit_2026" }]])
            return { rows: ancestors }
          },
        ],
        [/^FETCH/, { values: [] }],
      ])
      return queryPostgres(client, "SELECT 1", { ...QUERY, exclude: ["secrets", "public.audit"] })
    }
    expect(((await scoped(plan([["public", "secrets"]]))) as DbRefusal).message).toContain(
      "devDatabase.exclude",
    )
    expect(((await scoped(plan([["pg_catalog", "pg_class"]]))) as DbRefusal).message).toContain(
      "outside the allowed schemas",
    )
    expect(
      code(await scoped(plan([["public", "audit_2026"]]), [{ schema: "public", name: "audit" }])),
    ).toBe("NIFRA_DB_TABLE_EXCLUDED")
    expect(code(await scoped(plan([["public", "audit_2026"]]), []))).toBeUndefined()
    expect(code(await scoped(plan([], [["pg_catalog", "pg_stat_get_activity"]])))).toBe(
      "NIFRA_DB_TABLE_EXCLUDED",
    )
    expect(code(await scoped(plan([], [["public", "dblink"]])))).toBe("NIFRA_DB_FUNCTION_REFUSED")
    expect(code(await scoped(plan([], [["pg_catalog", "generate_series"]])))).toBeUndefined()
  })

  test("the role gate runs inside the transaction before the statement", async () => {
    const { client, log } = fakeClient([
      [/current_user::text AS role/, { rows: [{ ...ROLE_ROW, superuser: true }] }],
    ])
    expect(code(await queryPostgres(client, "SELECT 1", QUERY))).toBe("NIFRA_DB_SUPERUSER")
    expect(log.some((line) => line.startsWith("DECLARE"))).toBe(false)
    expect(log.slice(-2)).toEqual(["ROLLBACK", "release"])
    const missing = fakeClient([[/current_user::text AS role/, { rows: [] }]])
    expect(code(await queryPostgres(missing.client, "SELECT 1", QUERY))).toBe("NIFRA_DB_DRIVER")
    const inspected = fakeClient([[/current_user::text AS role/, { rows: [ROLE_ROW] }]])
    expect(await inspectPostgresRole(inspected.client, { timeoutMs: 100 })).toMatchObject({
      role: "reader",
      serverVersionNum: 180004,
    })
  })

  test("server refusals, connect failures and a dead connection map to codes", async () => {
    const declared = fakeClient([
      [/current_user::text AS role/, { rows: [ROLE_ROW] }],
      [
        /^DECLARE/,
        fail("0A000", "DECLARE CURSOR must not contain data-modifying statements in WITH"),
      ],
      [/^ROLLBACK/, fail("57P01", "terminating connection")],
    ])
    expect(code(await queryPostgres(declared.client, "WITH d AS (SELECT 1) SELECT 1", QUERY))).toBe(
      "NIFRA_DB_WRITE_REFUSED",
    )
    expect(declared.log.at(-1)).toBe("release")
    const unreachable = fakeClient([], { reserveFails: true })
    const refused = await queryPostgres(unreachable.client, "SELECT 1", QUERY)
    expect(refused).toMatchObject({ code: "NIFRA_DB_DRIVER" })
    expect((refused as DbRefusal).message).toStartWith("could not connect")
    expect(code(await queryPostgres(unreachable.client, "DELETE FROM x", QUERY))).toBe(
      "NIFRA_DB_WRITE_REFUSED",
    )
    await expect(inReadOnlyTransaction(unreachable.client, 0, async () => 1)).rejects.toThrow(
      RangeError,
    )
  })

  test("explain gates through a closed cursor, checks the verbose plan, then plans plainly", async () => {
    const big = {
      Plan: { "Node Type": "Append", Plans: [{ Plans: [{ Plans: [{ pad: "x".repeat(5000) }] }] }] },
    }
    const { client, log } = fakeClient([
      [/current_user::text AS role/, { rows: [ROLE_ROW] }],
      [/^EXPLAIN \(VERBOSE/, plan([["public", "orders"]])],
      [/^EXPLAIN \(ANALYZE, FORMAT JSON\)/, { rows: [{ "QUERY PLAN": [big] }] }],
      [
        /^EXPLAIN \(FORMAT JSON\)/,
        { rows: [{ "QUERY PLAN": '[{"Plan":{"Node Type":"Seq Scan"}}]' }] },
      ],
    ])
    expect(await explainPostgres(client, "SELECT * FROM orders", QUERY)).toEqual({
      plan: [{ Plan: { "Node Type": "Seq Scan" } }],
      analyzed: false,
      truncated: false,
    })
    expect(log.filter((line) => /^(DECLARE|CLOSE)/.test(line))).toEqual([
      "DECLARE nifra_c NO SCROLL CURSOR FOR SELECT * FROM orders",
      "CLOSE nifra_c",
    ])
    const analyzed = await explainPostgres(client, "SELECT * FROM orders", {
      ...QUERY,
      analyze: true,
    })
    expect(analyzed).toMatchObject({ analyzed: true, truncated: true })
    expect(JSON.stringify((analyzed as { plan: unknown }).plan)).not.toContain("xxxx")
    const tiny = await explainPostgres(client, "SELECT * FROM orders", {
      ...QUERY,
      analyze: true,
      maxResultBytes: 5,
    })
    expect(tiny).toMatchObject({ plan: null, truncated: true })
    const refused = fakeClient([
      [/current_user::text AS role/, { rows: [ROLE_ROW] }],
      [/^EXPLAIN \(VERBOSE/, plan([["public", "secrets"]])],
    ])
    expect(code(await explainPostgres(refused.client, "SELECT 1", QUERY))).toBe(
      "NIFRA_DB_TABLE_EXCLUDED",
    )
  })
})

describe("schema and role SQL over a scripted client", () => {
  const relations = [
    { schema: "public", name: "orders", kind: "r", estimate: 10.4, reaches: [] },
    { schema: "public", name: "events", kind: "p", estimate: -1, reaches: "[]" },
    { schema: "public", name: "summary", kind: "v", estimate: 0, reaches: [["public", "orders"]] },
    { schema: "public", name: "secrets", kind: "r", estimate: 1, reaches: [] },
    {
      schema: "public",
      name: "secret_view",
      kind: "v",
      estimate: 0,
      reaches: [["public", "secrets"]],
    },
    {
      schema: "public",
      name: "catalog_view",
      kind: "v",
      estimate: 0,
      reaches: [["pg_catalog", "pg_class"]],
    },
    { schema: "public", name: "odd", kind: "x", estimate: 3, reaches: [[]] },
  ]
  const schemaClient = () =>
    fakeClient([
      [
        /c\.reltuples::float8 AS estimate/,
        (values) => {
          expect(values).toEqual([["public"]])
          return { rows: relations }
        },
      ],
      [
        /pg_catalog\.format_type/,
        {
          rows: [
            {
              schema: "public",
              table: "orders",
              name: "id",
              type: "bigint",
              nullable: false,
              default_value: "nextval('orders_id_seq'::regclass)",
              primary_key: true,
            },
            {
              schema: "public",
              table: "orders",
              name: "api_key",
              type: "text",
              nullable: true,
              default_value: null,
              primary_key: false,
            },
          ],
        },
      ],
      [
        /k\.contype = 'f'/,
        {
          rows: [
            {
              schema: "public",
              table: "orders",
              columns: '["user_id"]',
              ref_schema: "public",
              ref_table: "users",
              ref_columns: ["id"],
            },
          ],
        },
      ],
      [
        /pg_catalog\.pg_get_indexdef/,
        {
          rows: [
            {
              schema: "public",
              table: "orders",
              name: "orders_pkey",
              is_unique: true,
              columns: ["id"],
            },
          ],
        },
      ],
    ])

  test("lists exposed relations with columns, keys and indexes; hides what reaches an excluded one", async () => {
    const { client } = schemaClient()
    const schema = await readPostgresSchema(client, {
      timeoutMs: 1000,
      exclude: ["secrets"],
      redaction: {
        column: (name) => name === "api_key",
        text: (value) => value.replace("orders", "o"),
      },
    })
    if (isDbRefusal(schema)) throw new Error(schema.message)
    expect(
      schema.tables.map((table) => `${table.kind}:${table.name}:${table.rowEstimate}`),
    ).toEqual(["table:orders:10", "partitioned table:events:null", "view:summary:null"])
    expect(schema.excludedCount).toBe(4)
    expect(schema.tables[0]).toMatchObject({
      schema: "public",
      columns: [
        {
          name: "id",
          type: "bigint",
          nullable: false,
          default: "nextval('o_id_seq'::regclass)",
          primaryKey: true,
          redacted: false,
        },
        { name: "api_key", nullable: true, default: null, redacted: true },
      ],
      foreignKeys: [
        { columns: ["user_id"], references: { schema: "public", table: "users", columns: ["id"] } },
      ],
      indexes: [{ name: "orders_pkey", unique: true, columns: ["id"] }],
    })
    const one = await readPostgresSchema(schemaClient().client, {
      timeoutMs: 1000,
      table: "public.EVENTS",
    })
    expect(isDbRefusal(one) ? one.code : one.tables.map((table) => table.name)).toEqual(["events"])
    const hidden = await readPostgresSchema(schemaClient().client, {
      timeoutMs: 1000,
      exclude: ["secrets"],
      table: "secret_view",
    })
    expect(code(hidden)).toBe("NIFRA_DB_TABLE_EXCLUDED")
  })

  const roleClient = (version: number, excluded: readonly Record<string, unknown>[] = []) =>
    fakeClient([
      [/current_database\(\)::text AS database/, { rows: [{ database: 'app"db', version }] }],
      [
        /WITH RECURSIVE picked/,
        (values) => {
          expect(values).toEqual([["public", "sales"], ["secrets"], ["secrets"]])
          return { rows: excluded }
        },
      ],
    ])

  test("Postgres 14+ with nothing excluded grants pg_read_all_data", async () => {
    const sql = await postgresRoleSql(roleClient(160002).client, { timeoutMs: 1000 })
    if (isDbRefusal(sql)) throw new Error(sql.message)
    expect(sql).toMatchObject({
      role: "nifra_dev_reader",
      database: 'app"db',
      serverVersionNum: 160002,
    })
    expect(sql.statements.filter((line) => !line.startsWith("--"))).toEqual([
      'CREATE ROLE "nifra_dev_reader" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;',
      'ALTER ROLE "nifra_dev_reader" SET default_transaction_read_only = on;',
      'GRANT CONNECT ON DATABASE "app""db" TO "nifra_dev_reader";',
      'GRANT pg_read_all_data TO "nifra_dev_reader";',
    ])
  })

  test("before Postgres 14, or with exclusions, grants per schema and revokes the excluded", async () => {
    const old = await postgresRoleSql(roleClient(130011).client, {
      timeoutMs: 1000,
      role: 'we"ird',
    })
    if (isDbRefusal(old)) throw new Error(old.message)
    expect(old.statements.slice(-3)).toEqual([
      'GRANT USAGE ON SCHEMA "public" TO "we""ird";',
      'GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "we""ird";',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT ON TABLES TO "we""ird";',
    ])
    const excluded = await postgresRoleSql(
      roleClient(180000, [
        { schema: "public", name: "secrets" },
        { schema: "sales", name: "secrets_2026" },
      ]).client,
      { timeoutMs: 1000, schemas: ["public", "sales"], exclude: ["Secrets"] },
    )
    if (isDbRefusal(excluded)) throw new Error(excluded.message)
    expect(excluded.statements.some((line) => line.includes("pg_read_all_data"))).toBe(false)
    expect(excluded.statements.filter((line) => line.startsWith("GRANT SELECT"))).toHaveLength(2)
    expect(excluded.statements.slice(-2)).toEqual([
      'REVOKE SELECT ON TABLE "public"."secrets" FROM "nifra_dev_reader";',
      'REVOKE SELECT ON TABLE "sales"."secrets_2026" FROM "nifra_dev_reader";',
    ])
  })
})
