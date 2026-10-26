import { describe, expect, test } from "bun:test"
import { SQL } from "bun"
import { isDbRefusal } from "../src/engine.ts"
import {
  extended,
  inReadOnlyTransaction,
  type PgConnection,
  type PgQuery,
  pgFailure,
  planDocument,
  planReads,
} from "../src/internal/pg-exec.ts"
import {
  definerRefusal,
  type Exposure,
  grantRefusal,
  hiddenReach,
  judgeExposure,
  partialGrantRefusal,
  reachKey,
} from "../src/internal/pg-grants.ts"
import {
  functionCalls,
  lexPostgres,
  lintPostgres,
  tableAliasLists,
  withoutTerminator,
} from "../src/internal/pg-lexer.ts"
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
import { generate, KNOWN, mulberry32 } from "./fixtures/canary-grammar.ts"
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
      // Function refusals come from the catalog allowlist once connected: the live suite owns them.
      if (serverOwned.has(entry.name) || entry.postgres === "NIFRA_DB_FUNCTION_REFUSED") {
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
    expect(lintPostgres("SELECT dblink_connect('x')")).toBeUndefined()
  })

  test("functionCalls names every call as the server resolves it, strings and comments skipped", () => {
    const named = (sql: string) =>
      functionCalls(sql).map(({ schema, name }) => (schema === null ? name : `${schema}.${name}`))
    expect(named("SELECT word FROM ts_stat('SELECT to_tsvector(api_key) FROM secrets')")).toEqual([
      "ts_stat",
    ])
    expect(named("SELECT * FROM public.crosstab('x') AS c(a int, b int)")).toEqual([
      "public.crosstab",
      "c",
    ])
    expect(named('SELECT PG_CATALOG . "Lower" /* x */ (Upper(a)), $$f(1)$$, -- g(\n 1')).toEqual([
      "pg_catalog.Lower",
      "upper",
    ])
    // Only ASCII folds, as Postgres downcases a bare identifier; every name is cut to 63 bytes.
    expect(named("SELECT \u00C9TAT(1), Ab(2), ab(3)")).toEqual(["\u00C9tat", "ab"])
    const long = `f${"x".repeat(80)}`
    expect(named(`SELECT ${long}(1)`)).toEqual([long.slice(0, 63)])
    expect(named(`SELECT "${"\u00E9".repeat(40)}"(1)`)).toEqual(["\u00E9".repeat(31)])
    expect(named("SELECT 1")).toEqual([])
  })

  test("tableAliasLists finds a table given a column alias list, and nothing else", () => {
    const listed = (sql: string) =>
      tableAliasLists(sql).map(({ table, alias }) => `${table} ${alias}`)
    for (const [sql, found] of [
      ["SELECT c FROM users AS t(a, b, c)", "users t"],
      ["SELECT c FROM public.users t(a, b, c)", "users t"],
      ["SELECT * FROM ONLY users t(a)", "users t"],
      ["SELECT * FROM ONLY (public.users) AS t(a)", "users t"],
      ["SELECT * FROM users * t(a)", "users t"],
      ['SELECT * FROM "Users" "T"(a)', "Users T"],
      ["SELECT 1 FROM orders o JOIN users AS t(a, b) ON true", "users t"],
      ["SELECT 1 FROM orders o, users t(a)", "users t"],
      ["SELECT 1 FROM (orders o JOIN users t(a) ON true)", "users t"],
      ["SELECT (SELECT c FROM users t(a, b, c) LIMIT 1) FROM (SELECT 1) t", "users t"],
      ["WITH x AS (SELECT c FROM users t(a, b, c)) SELECT * FROM x", "users t"],
    ] as const) {
      expect({ sql, found: listed(sql) }).toEqual({ sql, found: [found] })
    }
    for (const sql of [
      "SELECT * FROM users u WHERE (u.id = 1)",
      "SELECT * FROM users WHERE (id = 1)",
      "SELECT * FROM users LIMIT (5)",
      "SELECT * FROM users TABLESAMPLE SYSTEM (10)",
      "SELECT * FROM orders JOIN users USING (id)",
      "SELECT * FROM users WINDOW w AS (PARTITION BY id)",
      "SELECT * FROM generate_series(1, 3) AS g(n)",
      "SELECT * FROM pg_catalog.generate_series(1, 3) g(n)",
      "SELECT * FROM unnest(ARRAY[1]) WITH ORDINALITY AS u(x, n)",
      "SELECT * FROM ROWS FROM (generate_series(1, 2)) AS r(n)",
      "SELECT * FROM users, LATERAL unnest(tags) AS tag(t)",
      "SELECT * FROM (SELECT * FROM users) AS s(a, b)",
      "WITH a AS (SELECT 1), b AS MATERIALIZED (SELECT 2) SELECT * FROM a, b",
      "WITH a(x) AS (SELECT 1) SELECT * FROM a",
      "SELECT CAST(price AS numeric(10, 2)), substring(name FROM 1 FOR 2) FROM orders",
      "SELECT extract(year FROM placed), a IS DISTINCT FROM b FROM orders",
      "SELECT 'FROM users t(a)'",
    ]) {
      expect({ sql, found: listed(sql) }).toEqual({ sql, found: [] })
    }
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

describe("canary grammar", () => {
  test("a seed fixes the cases, which mix refused and answered reads and all pass the tokenizer", () => {
    const cases = generate(mulberry32(0x5eed), 2000)
    expect(generate(mulberry32(0x5eed), 2000)).toEqual(cases)
    expect(cases.some((testCase) => testCase.refuse)).toBe(true)
    expect(cases.some((testCase) => !testCase.refuse)).toBe(true)
    // The oracle is for the layers behind the tokenizer: a case it refuses would prove nothing there.
    const linted = [...KNOWN, ...cases].filter(
      (testCase) => lintPostgres(testCase.sql) !== undefined,
    )
    expect(linted).toEqual([])
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
      columns: [],
      outputs: [],
      calls: [{ schema: "pg_catalog", name: "generate_series" }],
    })
    let deep: unknown = { "Relation Name": "deep", Schema: "public" }
    for (let level = 0; level < 300; level++) deep = { Plan: deep }
    expect(planReads(deep).relations).toEqual([])
    // A FROM-clause function with no schema resolves on the search path; two qualified calls of one
    // name stay apart.
    expect(
      planReads([
        {
          Plan: {
            "Node Type": "Function Scan",
            "Function Name": "unqualified",
            Filter: "(a.f(1) AND b.f(2))",
          },
        },
      ]).calls,
    ).toEqual([
      { schema: null, name: "unqualified" },
      { schema: "a", name: "f" },
      { schema: "b", name: "f" },
    ])
    expect(planDocument([{ "QUERY PLAN": '[{"Plan":{}}]' }])).toEqual([{ Plan: {} }])
    expect(planDocument([{ "QUERY PLAN": [{ Plan: {} }] }])).toEqual([{ Plan: {} }])
    expect(planDocument([])).toBeUndefined()
  })

  test("planReads names the columns plan expressions use, by their scan's alias", () => {
    const users = { schema: "public", name: "users" }
    const scan = (alias: string, output: string[], extra: Record<string, unknown> = {}) => ({
      "Node Type": "Seq Scan",
      "Relation Name": "users",
      Schema: "public",
      Alias: alias,
      Output: output,
      ...extra,
    })
    const all = ["u.id", "u.email", "u.password"]
    // An aggregate over a physical target list: the scan's output is deferred, the parent's counts.
    const counted = planReads([
      {
        Plan: {
          "Node Type": "Aggregate",
          Output: ["string_agg(u.password, ','::text)"],
          Plans: [{ "Node Type": "Gather", Output: all, Plans: [scan("u", all)] }],
        },
      },
    ])
    expect(counted.columns).toEqual([{ relation: users, column: "password" }])
    expect(counted.outputs).toEqual([
      { relation: users, columns: ["id", "email", "password"] },
      { relation: users, columns: ["id", "email", "password"] },
    ])
    // A union child's output and a SubPlan's are what the query asked for: they count.
    const union = planReads([
      {
        Plan: {
          "Node Type": "Append",
          Output: ["u.id", "u.email"],
          Plans: [
            scan("u", ["u.id", "u.email"]),
            scan("u_1", ["u_1.id", "u_1.password"], { Filter: '("u_1"."email" ~~ \'a%\'::text)' }),
          ],
        },
      },
    ])
    expect(union.outputs).toEqual([])
    expect(union.columns.map((c) => c.column).sort()).toEqual(["email", "id", "password"])
    const sub = planReads([
      {
        Plan: {
          "Node Type": "Result",
          Output: ["(SubPlan 1)"],
          Plans: [scan("u", ["u.password"], { "Parent Relationship": "SubPlan" })],
        },
      },
    ])
    expect(sub.columns).toEqual([{ relation: users, column: "password" }])
    // A whole-row reference, a string that merely spells a column, and an alias that is not a scan.
    const whole = planReads([
      {
        Plan: {
          "Node Type": "Subquery Scan",
          Alias: "q",
          Output: ["row_to_json(u.*)", "'u.password'::text", "q.password"],
          Plans: [scan("u", all, { "Parent Relationship": "Subquery" })],
        },
      },
    ])
    expect(whole.columns.map((c) => c.column).sort()).toEqual(["*", "email", "id", "password"])
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
  const connection: PgConnection = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) =>
      query(
        strings.reduce((text, part, index) => `${text}${index > 0 ? `$${index}` : ""}${part}`, ""),
        values,
      ),
    {
      unsafe: (text: string) => query(text, []),
      release: () => {
        log.push("release")
      },
    },
  )
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

/** `pg_proc` facts for the function allowlist, keyed by name: volatility, parallel safety, flags. */
const PROCS: Readonly<Record<string, readonly Record<string, unknown>[]>> = {
  generate_series: [{ schema: "pg_catalog", volatility: "i", parallel: "s" }],
  lower: [{ schema: "pg_catalog", volatility: "i", parallel: "s" }],
  random: [{ schema: "pg_catalog", volatility: "v", parallel: "r" }],
  pg_sleep: [{ schema: "pg_catalog", volatility: "v", parallel: "s" }],
  table_to_xml: [{ schema: "pg_catalog", volatility: "s", parallel: "r" }],
  ts_rewrite: [
    { schema: "pg_catalog", volatility: "i", parallel: "s" },
    { schema: "pg_catalog", volatility: "v", parallel: "u" },
  ],
  dblink: [{ schema: "public", volatility: "v", parallel: "r", extension: true }],
  crosstab: [{ schema: "public", volatility: "s", parallel: "u", extension: true }],
  uuid_generate_v4: [{ schema: "public", volatility: "v", parallel: "s", extension: true }],
  full_name: [{ schema: "public", volatility: "s", parallel: "u" }],
  bump: [{ schema: "public", volatility: "v", parallel: "u" }],
  owner_read: [{ schema: "public", volatility: "s", parallel: "s", definer: true }],
  my_agg: [{ schema: "public", volatility: "i", parallel: "s", aggregate: true }],
  off_path: [{ schema: "other", volatility: "v", parallel: "u" }],
}

const procRule: Rule = [
  /p\.proname = ANY\(ARRAY/,
  (values) => {
    const names = Array.isArray(values[0])
      ? values[0].filter((name) => typeof name === "string")
      : []
    return {
      rows: names.flatMap((name) =>
        (PROCS[name] ?? []).map((proc) => ({
          name,
          definer: false,
          aggregate: false,
          extension: false,
          // The fake search path: pg_catalog, then public.
          visible: proc.schema === "pg_catalog" || proc.schema === "public",
          ...proc,
        })),
      ),
    }
  },
]

describe("grant gate", () => {
  const exposure = (
    name: string,
    columns: Record<string, boolean>,
    patch: Partial<Exposure> = {},
  ): Exposure => ({
    relation: { schema: "public", name },
    kind: "r",
    readable: Object.values(columns).some(Boolean),
    columns: Object.entries(columns).map(([column, readable]) => ({ name: column, readable })),
    ancestors: [],
    reads: [],
    ...patch,
  })
  const scope = { exclude: ["secrets"] }
  const masked = (name: string) => name === "password_hash"

  test("a role that may read a masked column, an excluded table or a view over either is refused", () => {
    const exposures = [
      exposure("orders", { id: true }),
      exposure(
        "secret_copy",
        { value: true },
        {
          kind: "m",
          reads: [{ relation: { schema: "public", name: "secrets" }, column: "value" }],
        },
      ),
      exposure("secrets", { value: true }),
      exposure("users", { id: true, password_hash: true }),
    ]
    const refused = grantRefusal(
      "reader",
      hiddenReach(exposures, judgeExposure(exposures, scope, masked)),
    )
    expect(code(refused)).toBe("NIFRA_DB_ROLE_GRANTS")
    expect(isDbRefusal(refused) ? refused.message : "").toBe(
      'role "reader" may read public.secret_copy (it is a view that reads public.secrets, which is hidden), public.secrets (devDatabase.exclude leaves it out), public.users.password_hash (masked as a credential); the database must refuse what the declaration hides, so revoke each grant that gives the role SELECT on it (to PUBLIC, to the role, or to a role whose privileges it has) or connect as a role that cannot read it',
    )
    expect(isDbRefusal(refused) ? refused.fix : "").toContain("nifra db role")
    const granted = [
      exposure("orders", { id: true }),
      exposure(
        "secret_copy",
        { value: false },
        {
          kind: "m",
          reads: [{ relation: { schema: "public", name: "secrets" }, column: "value" }],
        },
      ),
      exposure("secrets", { value: false }),
      exposure("users", { id: true, password_hash: false }),
    ]
    expect(
      grantRefusal("reader", hiddenReach(granted, judgeExposure(granted, scope, masked))),
    ).toBeUndefined()
    // Without masking, only exclusion hides anything.
    expect(
      grantRefusal("reader", hiddenReach(granted, judgeExposure(granted, {}, undefined))),
    ).toBeUndefined()
    // A relation hidden whole has no masked columns of its own.
    expect(
      judgeExposure([exposure("secrets", { password_hash: true })], scope, masked).masked.size,
    ).toBe(0)
  })

  test("the refusal lists four and counts the rest", () => {
    const exposures = ["a", "b", "c", "d", "e", "f"].map((name) =>
      exposure(name, { password_hash: true }),
    )
    const refused = grantRefusal("r", hiddenReach(exposures, judgeExposure(exposures, {}, masked)))
    expect(isDbRefusal(refused) ? refused.message : "").toContain("public.d.password_hash")
    expect(isDbRefusal(refused) ? refused.message : "").toContain(", and 2 more;")
    expect(isDbRefusal(refused) ? refused.message : "").not.toContain("public.e.")
    const four = exposures.slice(0, 4)
    const all = grantRefusal("r", hiddenReach(four, judgeExposure(four, {}, masked)))
    expect(isDbRefusal(all) ? all.message : "").not.toContain(" more")
  })

  test("a whole-row or no-column view read, and a view over an out-of-schema relation, hide the view", () => {
    const view = (reads: Exposure["reads"]) => exposure("v", { x: true }, { kind: "v", reads })
    const hidden = (reads: Exposure["reads"]) =>
      judgeExposure([view(reads)], scope, masked).hidden.has(JSON.stringify(["public", "v"]))
    expect(
      hidden([{ relation: { schema: "public", name: "users" }, column: "password_hash" }]),
    ).toBe(true)
    expect(hidden([{ relation: { schema: "public", name: "users" }, column: "email" }])).toBe(false)
    expect(hidden([{ relation: { schema: "public", name: "secrets" }, column: null }])).toBe(true)
    expect(hidden([{ relation: { schema: "auth", name: "users" }, column: "id" }])).toBe(true)
    expect(hidden([])).toBe(false)
  })

  test("a server refusal of a partly granted table names the columns it may not read", () => {
    const exposures = [
      exposure("users", { id: true, email: true, password_hash: false }),
      exposure("secrets", { value: false }),
      exposure("orders", { id: true }),
    ]
    const denied = (errno: string, message: string) =>
      partialGrantRefusal(Object.assign(new Error(message), { errno }), exposures)
    expect(denied("42501", "permission denied for table users")).toMatchObject({
      code: "NIFRA_DB_COLUMN_REFUSED",
      message:
        "the role may read only some columns of public.users, not password_hash: select the others by name",
    })
    expect(denied("42501", 'permission denied for relation "users"')).toMatchObject({
      code: "NIFRA_DB_COLUMN_REFUSED",
    })
    expect(denied("42501", "permission denied for table secrets")).toBeUndefined()
    expect(denied("42501", "permission denied for table orders")).toBeUndefined()
    expect(partialGrantRefusal(null, exposures)).toBeUndefined()
    expect(denied("42501", "permission denied for function f")).toBeUndefined()
    expect(denied("42P01", "permission denied for table users")).toBeUndefined()
    expect(partialGrantRefusal("permission denied for table users", exposures)).toBeUndefined()
  })

  test("over a scripted client: refused before the statement, and a column denial is named", async () => {
    // A driver may hand json back as its text.
    const exposureRows = (passwordReadable: boolean, asText = false) => {
      const json = (value: unknown) => (asText ? JSON.stringify(value) : value)
      return {
        rows: [
          {
            schema: "public",
            name: "users",
            kind: "r",
            readable: true,
            names: json(["id", "password_hash"]),
            granted: json([true, passwordReadable]),
            ancestors: null,
            reads: null,
          },
        ],
      }
    }
    const options = { ...QUERY, redaction: { column: masked } }
    const broad = fakeClient([
      [/current_user::text AS role/, { rows: [ROLE_ROW] }],
      [/AS readable/, exposureRows(true)],
    ])
    expect(code(await queryPostgres(broad.client, "SELECT id FROM users", options))).toBe(
      "NIFRA_DB_ROLE_GRANTS",
    )
    expect(broad.log.some((line) => line.startsWith("DECLARE"))).toBe(false)
    const text = fakeClient([
      [/current_user::text AS role/, { rows: [ROLE_ROW] }],
      [/AS readable/, exposureRows(true, true)],
    ])
    expect(code(await queryPostgres(text.client, "SELECT id FROM users", options))).toBe(
      "NIFRA_DB_ROLE_GRANTS",
    )
    const narrow = fakeClient([
      [/current_user::text AS role/, { rows: [ROLE_ROW] }],
      [/AS readable/, exposureRows(false)],
      [/^DECLARE/, fail("42501", "permission denied for table users")],
    ])
    expect(await queryPostgres(narrow.client, "SELECT * FROM users", options)).toMatchObject({
      code: "NIFRA_DB_COLUMN_REFUSED",
      message: expect.stringContaining("not password_hash"),
    })
    expect(narrow.log.slice(-2)).toEqual(["ROLLBACK", "release"])
  })

  test("a SECURITY DEFINER function the role may execute refuses it unless allowFunctions names it", async () => {
    const definers = [
      { schema: "public", name: "Owner_Hash", args: "integer" },
      { schema: "app", name: "sum_secret", args: "x numeric" },
    ]
    expect(definerRefusal("reader", [], undefined)).toBeUndefined()
    expect(definerRefusal("reader", definers, ["owner_hash", "APP.sum_secret"])).toBeUndefined()
    expect(definerRefusal("reader", definers, ["public.owner_hash"])?.message).toStartWith(
      'role "reader" may execute app.sum_secret(x numeric), which run SECURITY DEFINER code',
    )
    const many = Array.from({ length: 6 }, (_, index) => ({
      schema: "s",
      name: `f${index}`,
      args: "",
    }))
    expect(definerRefusal("reader", many, undefined)?.message).toContain(
      "s.f0(), s.f1(), s.f2(), s.f3(), and 2 more,",
    )
    expect(definerRefusal("reader", many.slice(0, 4), undefined)?.message).not.toContain(" more")
    const scripted = fakeClient([
      [/current_user::text AS role/, { rows: [ROLE_ROW] }],
      [/AS readable/, { rows: [] }],
      [/WITH reach AS/, (values) => ({ rows: values[0] === ROLE_ROW.role ? definers : [] })],
    ])
    expect(code(await queryPostgres(scripted.client, "SELECT 1", QUERY))).toBe(
      "NIFRA_DB_ROLE_GRANTS",
    )
    expect(scripted.log.some((line) => line.startsWith("DECLARE"))).toBe(false)
    const accepted = await queryPostgres(scripted.client, "SELECT 1", {
      ...QUERY,
      allowFunctions: ["owner_hash", "sum_secret"],
    })
    expect(code(accepted)).not.toBe("NIFRA_DB_ROLE_GRANTS")
  })

  test("a refusal names each grant a hidden read or a SECURITY DEFINER call is held through", () => {
    const exposures = [
      exposure("secrets", { value: true }),
      exposure("users", { id: true, password_hash: true }),
    ]
    const reach = hiddenReach(exposures, judgeExposure(exposures, scope, masked))
    const [secrets, hash] = reach
    if (secrets === undefined || hash === undefined) throw new Error("expected two reads")
    const held = new Map([
      [
        reachKey(secrets),
        [
          { grantee: null, column: null, member: false },
          { grantee: "app_read", column: null, member: false },
          { grantee: "app_read", column: "value", member: false },
        ],
      ],
      [reachKey(hash), [{ grantee: "pg_read_all_data", column: null, member: true }]],
    ])
    expect(grantRefusal("reader", reach, held)?.message).toStartWith(
      'role "reader" may read public.secrets (devDatabase.exclude leaves it out; granted to PUBLIC, "app_read"), public.users.password_hash (masked as a credential; granted to "pg_read_all_data");',
    )
    const definers = [
      { schema: "public", name: "Owner_Hash", args: "integer" },
      { schema: "app", name: "sum_secret", args: "x numeric" },
    ]
    const executes = new Map([
      [
        "app.sum_secret(x numeric)",
        [
          { grantee: null, column: null, member: false },
          { grantee: "reader", column: null, member: false },
        ],
      ],
    ])
    expect(definerRefusal("reader", definers, undefined, executes)?.message).toStartWith(
      'role "reader" may execute public.Owner_Hash(integer), app.sum_secret(x numeric) (granted to PUBLIC, "reader"), which run',
    )
  })

  test("over a scripted client: the grants are read only for a refusal, and named in it", async () => {
    const exposureRow = (readable: boolean) => ({
      schema: "public",
      name: "secrets",
      kind: "r",
      readable,
      names: ["value"],
      granted: [readable],
      ancestors: null,
      reads: null,
    })
    const scripted = (readable: boolean, definers: readonly Record<string, unknown>[]) =>
      fakeClient([
        [/current_user::text AS role/, { rows: [ROLE_ROW] }],
        [/AS readable/, { rows: [exposureRow(readable)] }],
        [
          /WITH target AS/,
          (values) => ({
            rows:
              values[1] === ROLE_ROW.role
                ? [
                    {
                      schema: "public",
                      name: "secrets",
                      col: null,
                      granted: null,
                      member: false,
                      holder: "app_read",
                    },
                  ]
                : [],
          }),
        ],
        [/WITH reach AS/, { rows: definers }],
        [
          /privilege_type = 'EXECUTE'/,
          (values) => ({
            rows:
              values[1] === ROLE_ROW.role
                ? [{ schema: "app", name: "sum_secret", args: "", holder: null }]
                : [],
          }),
        ],
      ])
    const grantsRead = (log: readonly string[]) =>
      log.filter((line) => line.includes("aclexplode")).length
    const tables = scripted(true, [])
    const refused = await queryPostgres(tables.client, "SELECT 1", QUERY)
    expect(isDbRefusal(refused) ? refused.message : "").toContain(
      'public.secrets (devDatabase.exclude leaves it out; granted to "app_read")',
    )
    expect(grantsRead(tables.log)).toBe(1)
    const definer = scripted(false, [{ schema: "app", name: "sum_secret", args: "" }])
    const unguarded = await queryPostgres(definer.client, "SELECT 1", QUERY)
    expect(isDbRefusal(unguarded) ? unguarded.message : "").toContain(
      "may execute app.sum_secret() (granted to PUBLIC), which run",
    )
    expect(grantsRead(definer.log)).toBe(1)
    const clean = scripted(false, [])
    expect(code(await queryPostgres(clean.client, "SELECT 1", QUERY))).not.toBe(
      "NIFRA_DB_ROLE_GRANTS",
    )
    expect(grantsRead(clean.log)).toBe(0)
  })
})

describe("extended", () => {
  test("hands Bun.SQL a template object it takes as one statement", async () => {
    const seen: TemplateStringsArray[] = []
    const query: PgQuery = {
      // biome-ignore lint/suspicious/noThenProperty: a PgQuery is awaitable by contract
      then: (onFulfilled, onRejected) => Promise.resolve([]).then(onFulfilled, onRejected),
      values: () => Promise.resolve([]),
    }
    const connection: PgConnection = Object.assign(
      (strings: TemplateStringsArray) => {
        seen.push(strings)
        return query
      },
      { unsafe: () => query, release: () => {} },
    )
    await extended(connection, "SELECT 1")
    const [strings] = seen
    if (strings === undefined) throw new Error("extended never called the connection")
    expect({
      keys: Object.keys(strings),
      raw: strings.raw,
      frozen: Object.isFrozen(strings),
    }).toEqual({ keys: ["0"], raw: ["SELECT 1"], frozen: true })
    // Bun.SQL checks the template object as it builds the query, which runs only once awaited.
    const sql = new SQL({ hostname: "127.0.0.1", port: 1, username: "nifra", database: "nifra" })
    let refusal: unknown
    try {
      sql(strings)
    } catch (error) {
      refusal = error
    } finally {
      await sql.close()
    }
    expect(refusal).toBeUndefined()
  })
})

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
      "BEGIN READ ONLY; SET LOCAL statement_timeout = 2000; SET LOCAL lock_timeout = 2000; SET LOCAL idle_in_transaction_session_timeout = 2000; SELECT pg_catalog.set_config('jit', 'off', true) WHERE pg_catalog.current_setting('server_version_num')::int >= 110000",
    )
    const declared = log.findIndex((line) => line.startsWith("DECLARE"))
    expect(log[declared]).toStartWith(
      "DECLARE nifra_c NO SCROLL CURSOR FOR SELECT (SELECT json_agg(nifra_k)",
    )
    expect(log[declared]).toContain("FROM ( SELECT o.id, o.id FROM orders o ) AS nifra_q")
    // The grant gate reads the role's privileges before the statement is planned.
    const granted = log.findIndex((line) => line.includes("has_any_column_privilege"))
    expect(granted).toBeGreaterThan(0)
    expect(granted).toBeLessThan(declared)
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
        procRule,
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
    expect(await scoped(plan([["public", "secrets"]]))).toMatchObject({
      message: expect.stringContaining("devDatabase.exclude"),
    })
    expect(await scoped(plan([["pg_catalog", "pg_class"]]))).toMatchObject({
      message: expect.stringContaining("outside the allowed schemas"),
    })
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

  test("a scan's narrowed row holding a masked column is refused; its full row is left to the parent", async () => {
    const columns = ["id", "email", "password_hash", "api_key"]
    const counted = async (
      output: readonly string[],
      masks: readonly string[] = ["password_hash"],
    ) => {
      const { client } = fakeClient([
        [/current_user::text AS role/, { rows: [ROLE_ROW] }],
        procRule,
        [
          /^EXPLAIN \(VERBOSE/,
          {
            rows: [
              {
                "QUERY PLAN": [
                  {
                    Plan: {
                      "Node Type": "Aggregate",
                      Output: ["count(*)"],
                      Plans: [
                        {
                          "Node Type": "Seq Scan",
                          "Relation Name": "users",
                          Schema: "public",
                          Alias: "u",
                          Output: output.map((column) => `u.${column}`),
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
        [
          /AS column/,
          { rows: columns.map((column) => ({ schema: "public", name: "users", column })) },
        ],
        [/^FETCH/, { values: [] }],
      ])
      return queryPostgres(client, "SELECT count(*) FROM users", {
        ...QUERY,
        redaction: { column: (name: string) => masks.includes(name) },
      })
    }
    expect(code(await counted(columns))).toBeUndefined()
    expect(await counted(["id", "password_hash"])).toMatchObject({
      code: "NIFRA_DB_COLUMN_REFUSED",
      message: "the query reads users.password_hash, masked as a credential",
    })
    expect(await counted(["password_hash", "api_key"], ["password_hash", "api_key"])).toMatchObject(
      {
        message: "the query reads users.password_hash, users.api_key, masked as credentials",
      },
    )
  })

  test("the function allowlist reads pg_proc for the statement's calls before planning, and the plan's after", async () => {
    const called = async (sql: string, planned: Answer = plan([]), allowFunctions?: string[]) => {
      const { client, log } = fakeClient([
        [/current_user::text AS role/, { rows: [ROLE_ROW] }],
        procRule,
        [/^EXPLAIN \(VERBOSE/, planned],
        [/^FETCH/, { values: [] }],
      ])
      const result = await queryPostgres(client, sql, {
        ...QUERY,
        ...(allowFunctions === undefined ? {} : { allowFunctions }),
      })
      return { result, declared: log.some((line) => line.startsWith("DECLARE")) }
    }
    for (const [sql, reason] of [
      ["SELECT pg_sleep(1)", "volatile"],
      ["SELECT table_to_xml('secrets', true, false, '')", "not parallel safe"],
      ["SELECT ts_rewrite('a'::tsquery, 'SELECT 1')", "volatile"],
      ["SELECT * FROM dblink('x', 'y') AS t(a int)", "volatile"],
      ["SELECT * FROM crosstab('SELECT 1') AS t(a int)", "not parallel safe"],
      ["SELECT bump()", "volatile"],
      ["SELECT owner_read(1)", "SECURITY DEFINER"],
      ["SELECT my_agg(x) FROM generate_series(1, 2) AS g(x)", "aggregate"],
      ['SELECT "public".bump()', "volatile"],
      ["SELECT other.off_path()", "volatile"],
    ] as const) {
      const { result, declared } = await called(sql)
      expect({ sql, code: code(result), declared }).toEqual({
        sql,
        code: "NIFRA_DB_FUNCTION_REFUSED",
        declared: false,
      })
      expect({ sql, message: isDbRefusal(result) ? result.message : "" }).toEqual({
        sql,
        message: expect.stringContaining(reason),
      })
    }
    for (const sql of [
      "SELECT lower('A'), random(), uuid_generate_v4(), full_name(1)",
      "SELECT * FROM generate_series(1, 2) AS g(x)",
      "SELECT pg_catalog.bump()",
      "SELECT nothing_by_this_name(1)",
      // Off the search path, an unqualified name cannot resolve to it.
      "SELECT off_path()",
    ]) {
      expect({ sql, code: code((await called(sql)).result) }).toEqual({ sql, code: undefined })
    }
    expect(code((await called("SELECT bump()", plan([]), ["bump"])).result)).toBeUndefined()
    expect(code((await called("SELECT bump()", plan([]), ["PUBLIC.bump"])).result)).toBeUndefined()
    expect(code((await called("SELECT bump()", plan([]), ["other.bump"])).result)).toBe(
      "NIFRA_DB_FUNCTION_REFUSED",
    )
    // A call the statement's text does not show, from a view's body, is caught in the plan.
    const viaView = {
      rows: [
        {
          "QUERY PLAN": [
            {
              Plan: {
                "Relation Name": "orders",
                Schema: "public",
                Output: ["owner_read(orders.id)"],
              },
            },
          ],
        },
      ],
    }
    expect(code((await called("SELECT * FROM orders", viaView)).result)).toBe(
      "NIFRA_DB_FUNCTION_REFUSED",
    )
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
    expect(refused).toMatchObject({
      code: "NIFRA_DB_DRIVER",
      message: expect.stringMatching(/^could not connect/),
    })
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
    expect(JSON.stringify(analyzed)).not.toContain("xxxx")
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

  test("explain refuses a masked column the plan uses, analyzed or not, before planning it", async () => {
    const reads = {
      rows: [
        {
          "QUERY PLAN": [
            {
              Plan: {
                "Node Type": "Seq Scan",
                "Relation Name": "users",
                Schema: "public",
                Alias: "users",
                Output: ["users.id"],
                Filter: "((users.password_hash)::text ~~ 'h%'::text)",
              },
            },
          ],
        },
      ],
    }
    for (const analyze of [false, true]) {
      const { client, log } = fakeClient([
        [/current_user::text AS role/, { rows: [ROLE_ROW] }],
        [/^EXPLAIN \(VERBOSE/, reads],
        [/WITH RECURSIVE planned/, { rows: [] }],
        [
          /pg_catalog\.pg_attribute/,
          {
            rows: [
              { schema: "public", name: "users", column: "id" },
              { schema: "public", name: "users", column: "password_hash" },
            ],
          },
        ],
      ])
      const explained = await explainPostgres(
        client,
        "SELECT id FROM users WHERE password_hash LIKE 'h%'",
        { ...QUERY, analyze, redaction: { column: (name) => name === "password_hash" } },
      )
      expect(code(explained)).toBe("NIFRA_DB_COLUMN_REFUSED")
      expect(log.some((line) => /^EXPLAIN \((ANALYZE, )?FORMAT JSON\)/.test(line))).toBe(false)
    }
  })

  test("a table's column alias list hides which column the plan reads: refused while a read relation holds a masked one", async () => {
    // `users AS t(a, b, id)` hands password_hash the name id; the plan prints `t.id`.
    const renamed = {
      rows: [
        {
          "QUERY PLAN": [
            {
              Plan: {
                "Node Type": "Seq Scan",
                "Relation Name": "users",
                Schema: "public",
                Alias: "t",
                Output: ["t.id"],
              },
            },
          ],
        },
      ],
    }
    const run = (column: (name: string) => boolean) => {
      const { client } = fakeClient([
        [/current_user::text AS role/, { rows: [ROLE_ROW] }],
        [/^EXPLAIN \(VERBOSE/, renamed],
        [/WITH RECURSIVE planned/, { rows: [] }],
        [
          /pg_catalog\.pg_attribute/,
          {
            rows: ["id", "email", "password_hash"].map((name) => ({
              schema: "public",
              name: "users",
              column: name,
            })),
          },
        ],
        [/^EXPLAIN \(FORMAT JSON\)/, { rows: [{ "QUERY PLAN": [{ Plan: {} }] }] }],
      ])
      return explainPostgres(client, "SELECT id FROM users AS t(a, b, id)", {
        ...QUERY,
        redaction: { column },
      })
    }
    const refused = await run((name) => name === "password_hash")
    expect(code(refused)).toBe("NIFRA_DB_COLUMN_REFUSED")
    expect(isDbRefusal(refused) ? refused.message : "").toContain("alias list t(...)")
    expect(code(await run((name) => name === "api_key"))).toBeUndefined()
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

  const roleClient = (version: number, exposures: readonly Record<string, unknown>[] = []) =>
    fakeClient([
      [/current_database\(\)::text AS database/, { rows: [{ database: 'app"db', version }] }],
      [/AS readable/, { rows: exposures }],
    ])

  const relation = (
    schema: string,
    name: string,
    columns: readonly string[],
    patch: Record<string, unknown> = {},
  ) => ({
    schema,
    name,
    kind: "r",
    readable: true,
    names: columns,
    granted: columns.map(() => true),
    ancestors: null,
    reads: null,
    ...patch,
  })

  test("lists, as comments, the REVOKE FROM PUBLIC each SECURITY DEFINER function needs", async () => {
    const scripted = fakeClient([
      [/current_database\(\)::text AS database/, { rows: [{ database: "app", version: 180000 }] }],
      [
        /WITH reach AS/,
        (values) => ({
          rows:
            values[0] === "public"
              ? [
                  { schema: "public", name: "Owner Hash", args: "id integer" },
                  { schema: "public", name: "trusted", args: "" },
                ]
              : [],
        }),
      ],
    ])
    const sql = await postgresRoleSql(scripted.client, {
      timeoutMs: 1000,
      allowFunctions: ["trusted"],
    })
    if (isDbRefusal(sql)) throw new Error(sql.message)
    expect(sql.statements.at(-1)).toBe(
      '-- REVOKE EXECUTE ON FUNCTION "public"."Owner Hash"(id integer) FROM PUBLIC;',
    )
    expect(sql.statements.join("\n")).not.toContain('"trusted"')
  })

  test("for a role that exists, names every grant it reads hidden data or SECURITY DEFINER code through", async () => {
    const role = "nifra_dev_reader"
    const scripted = fakeClient([
      [
        /current_database\(\)::text AS database/,
        { rows: [{ database: "app", version: 180000, present: true }] },
      ],
      [
        /AS readable/,
        {
          rows: [
            relation("public", "secrets", ["value"]),
            relation("public", "users", ["id", "password_hash"]),
          ],
        },
      ],
      [
        /WITH target AS/,
        (values) => ({
          rows:
            values[1] === role
              ? [
                  {
                    schema: "public",
                    name: "secrets",
                    col: null,
                    granted: null,
                    member: false,
                    holder: null,
                  },
                  {
                    schema: "public",
                    name: "secrets",
                    col: null,
                    granted: null,
                    member: false,
                    holder: role,
                  },
                  {
                    schema: "public",
                    name: "secrets",
                    col: null,
                    granted: null,
                    member: true,
                    holder: "pg_read_all_data",
                  },
                  {
                    schema: "public",
                    name: "users",
                    col: "password_hash",
                    granted: "password_hash",
                    member: false,
                    holder: "app read",
                  },
                  {
                    schema: "public",
                    name: "users",
                    col: "password_hash",
                    granted: "password_hash",
                    member: false,
                    holder: "app read",
                  },
                ]
              : [],
        }),
      ],
      [
        /WITH reach AS/,
        (values) => ({
          rows: values[0] === role ? [{ schema: "public", name: "f", args: "" }] : [],
        }),
      ],
      [
        /privilege_type = 'EXECUTE'/,
        (values) => ({
          rows:
            values[1] === role
              ? [
                  { schema: "public", name: "f", args: "", holder: null },
                  { schema: "public", name: "f", args: "", holder: role },
                ]
              : [],
        }),
      ],
    ])
    const sql = await postgresRoleSql(scripted.client, {
      timeoutMs: 1000,
      exclude: ["secrets"],
      redaction: { column: (name) => name === "password_hash" },
    })
    if (isDbRefusal(sql)) throw new Error(sql.message)
    expect(sql.statements.slice(-11)).toEqual([
      'REVOKE SELECT ON TABLE "public"."secrets" FROM "nifra_dev_reader";',
      'REVOKE SELECT ON TABLE "public"."users" FROM "nifra_dev_reader";',
      'GRANT SELECT ("id") ON TABLE "public"."users" TO "nifra_dev_reader";',
      '-- "nifra_dev_reader" has the privileges of pg_read_all_data, which reads every table past these REVOKEs: revoke that membership.',
      "-- These grants still let the role read what the REVOKEs above take away. The grant gate refuses it until each is revoked (grant SELECT back to the roles that need it):",
      '-- REVOKE SELECT ON TABLE "public"."secrets" FROM PUBLIC;',
      '-- REVOKE SELECT ("password_hash") ON TABLE "public"."users" FROM "app read";',
      "-- The role may execute these, which run SECURITY DEFINER code with their owner's rights past the grants above.",
      "-- The grant gate refuses it until EXECUTE on each is revoked from every grantee below (grant it back to the roles that call it) or the function is named in devDatabase.allowFunctions:",
      'REVOKE EXECUTE ON FUNCTION "public"."f"() FROM "nifra_dev_reader";',
      '-- REVOKE EXECUTE ON FUNCTION "public"."f"() FROM PUBLIC;',
    ])
  })

  test("Postgres 14+ with nothing excluded grants the allowed schemas only, never pg_read_all_data", async () => {
    const sql = await postgresRoleSql(roleClient(160002).client, { timeoutMs: 1000 })
    if (isDbRefusal(sql)) throw new Error(sql.message)
    expect(sql.role).toBe("nifra_dev_reader")
    expect(sql.database).toBe('app"db')
    expect(sql.serverVersionNum).toBe(160002)
    expect(sql.statements.filter((line) => !line.startsWith("--"))).toEqual([
      'CREATE ROLE "nifra_dev_reader" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;',
      'ALTER ROLE "nifra_dev_reader" SET default_transaction_read_only = on;',
      'GRANT CONNECT ON DATABASE "app""db" TO "nifra_dev_reader";',
      'GRANT USAGE ON SCHEMA "public" TO "nifra_dev_reader";',
      'GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "nifra_dev_reader";',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT ON TABLES TO "nifra_dev_reader";',
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
    const exposures = [
      // Listed before the view it reads, which only a second pass hides.
      relation("public", "a_copy_of_copy", ["value"], {
        kind: "v",
        reads: [["public", "secret_copy", "value"]],
      }),
      relation("public", "catalog_view", ["relname"], {
        kind: "v",
        reads: [["pg_catalog", "pg_class", "relname"]],
      }),
      relation("public", "hash_copy", ["id", "ph"], {
        kind: "m",
        reads: [
          ["public", "users", "id"],
          ["public", "users", "password_hash"],
        ],
      }),
      relation("public", "only_secret", ["api_key"]),
      relation("public", "orders", ["id", "total"]),
      relation("public", "secret_copy", ["value"], {
        kind: "m",
        reads: [["public", "secrets", "value"]],
      }),
      relation("public", "secrets", ["id", "value"]),
      relation("public", "user_emails", ["email"], {
        kind: "v",
        reads: [["public", "users", "email"]],
      }),
      relation("public", "users", ["id", "email", "password_hash"]),
      relation("sales", "secrets_2026", ["id", "value"], {
        ancestors: [["public", "secrets"]],
      }),
    ]
    const excluded = await postgresRoleSql(roleClient(180000, exposures).client, {
      timeoutMs: 1000,
      schemas: ["public", "sales"],
      exclude: ["Secrets"],
      redaction: { column: (name) => name === "password_hash" || name === "api_key" },
    })
    if (isDbRefusal(excluded)) throw new Error(excluded.message)
    expect(excluded.statements.some((line) => line.includes("pg_read_all_data"))).toBe(false)
    const who = '"nifra_dev_reader"'
    expect(excluded.statements.slice(-9)).toEqual([
      `REVOKE SELECT ON TABLE "public"."a_copy_of_copy" FROM ${who};`,
      `REVOKE SELECT ON TABLE "public"."catalog_view" FROM ${who};`,
      `REVOKE SELECT ON TABLE "public"."hash_copy" FROM ${who};`,
      `REVOKE SELECT ON TABLE "public"."only_secret" FROM ${who};`,
      `REVOKE SELECT ON TABLE "public"."secret_copy" FROM ${who};`,
      `REVOKE SELECT ON TABLE "public"."secrets" FROM ${who};`,
      `REVOKE SELECT ON TABLE "public"."users" FROM ${who};`,
      `GRANT SELECT ("id", "email") ON TABLE "public"."users" TO ${who};`,
      `REVOKE SELECT ON TABLE "sales"."secrets_2026" FROM ${who};`,
    ])
  })
})
