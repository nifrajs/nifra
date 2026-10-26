/**
 * The query grammar of the canary oracle (`postgres-canary.test.ts`): every read path into the data the
 * declaration hides, each tagged with whether a query through it must be refused. The fixture tables
 * are the oracle's: `users` with the masked `password_hash`, the excluded `secrets` (with
 * `child_secret`, `secret_view` and the materialized `secret_copy`), the excluded partitioned `audit`,
 * `hash_view` and the materialized `hash_copy` over the hash, and `outside.notes` beyond the schemas.
 */

/** Deterministic randomness, so a failing seed replays. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Column {
  readonly expr: string
  readonly hidden: boolean
}

interface Source {
  readonly from: string
  readonly columns: readonly Column[]
  /** Reading the source at all touches hidden data. */
  readonly hidden: boolean
  /** `x` names a row of it (not a function's scalar). */
  readonly rows: boolean
}

const column = (name: string, hidden = false): Column => ({ expr: `x.${name}`, hidden })
const source = (
  from: string,
  columns: readonly Column[],
  hidden: boolean,
  rows = true,
): Source => ({ from, columns, hidden, rows })

const USERS = [column("id"), column("email"), column("note"), column("password_hash", true)]
const SECRETS = [column("id"), column("value")]

const SOURCES: readonly Source[] = [
  source("users x", USERS, false),
  source("ONLY users x", USERS, false),
  // The plan check refuses an alias-listed scan of a table holding a masked column, whatever it reads.
  source(
    "users AS x(a, b, c, d)",
    [column("a"), column("b"), column("c", true), column("d")],
    true,
  ),
  source("emails x", [column("id"), column("email")], false),
  source("orders x", [column("id"), column("status"), column("total")], false),
  source("order_summary x", [column("status"), column("n")], false),
  source("generate_series(1, 3) AS x(n)", [column("n")], false, false),
  source("(SELECT id, email FROM users) x", [column("id"), column("email")], false),
  source("(SELECT id, password_hash AS p FROM users) x", [column("id"), column("p", true)], true),
  source(
    "orders o CROSS JOIN LATERAL (SELECT u.password_hash AS p FROM users u WHERE u.id = o.id) x",
    [column("p", true)],
    true,
  ),
  source("secrets x", SECRETS, true),
  source("ONLY secrets x", SECRETS, true),
  source("child_secret x", [...SECRETS, column("extra")], true),
  source("secret_view x", SECRETS, true),
  source("secret_copy x", [column("value")], true),
  source("hash_copy x", [column("id"), column("ph")], true),
  source("hash_view x", [column("id"), column("ph")], true),
  source("audit x", [column("id"), column("memo")], true),
  source("audit_2026 x", [column("id"), column("memo")], true),
  source("outside.notes x", [column("id"), column("body")], true),
]

const SCALARS: readonly ((c: string) => string)[] = [
  (c) => c,
  (c) => `${c}::text`,
  (c) => `upper(${c}::text)`,
  (c) => `reverse(${c}::text)`,
  (c) => `md5(${c}::text)`,
  (c) => `encode(convert_to(${c}::text, 'UTF8'), 'hex')`,
  (c) => `encode(convert_to(${c}::text, 'UTF8'), 'base64')`,
  (c) => `substr(${c}::text, 1)`,
  (c) => `format('%s!', ${c})`,
  (c) => `concat_ws('|', ${c}, 'k')`,
  (c) => `coalesce(${c}::text, '')`,
  (c) => `CASE WHEN ${c} IS NULL THEN 'n' ELSE ${c}::text END`,
  (c) => `(SELECT ${c}::text)`,
]
const AGGREGATES: readonly ((c: string) => string)[] = [
  (c) => `string_agg(${c}::text, ',')`,
  (c) => `json_agg(${c})`,
  (c) => `array_agg(${c})::text`,
  (c) => `count(${c})`,
  (c) => `max(${c}::text)`,
  (c) => `min(md5(${c}::text))`,
]
const WHOLE_ROWS = ["x", "x.*", "row_to_json(x)", "to_jsonb(x)::text", "x::text"]
const FILTERS: readonly ((c: string) => string)[] = [
  () => "",
  (c) => ` WHERE ${c}::text LIKE '%'`,
  (c) => ` WHERE md5(${c}::text) <> ''`,
]
const WRAPPERS: readonly ((q: string) => string)[] = [
  (q) => q,
  (q) => `WITH w AS MATERIALIZED (${q}) SELECT * FROM w`,
  (q) => `SELECT * FROM (${q}) s`,
  (q) => `SELECT 1 AS one WHERE EXISTS (${q})`,
]
// Functions that run SQL from a string, or read with their owner's rights: refused whatever they read.
const INNER = [
  ["note", "users"],
  ["password_hash", "users"],
  ["value", "secrets"],
  ["status", "orders"],
] as const
const STRING_SQL: readonly ((inner: string, table: string) => string)[] = [
  (inner, table) =>
    `SELECT word FROM ts_stat('SELECT to_tsvector(''simple'', ${inner}) FROM ${table}')`,
  (inner, table) => `SELECT query_to_xml('SELECT ${inner} FROM ${table}', true, false, '')`,
  (_, table) => `SELECT table_to_xml('${table}', true, false, '')`,
  (inner, table) =>
    `SELECT ts_rewrite('a'::tsquery, 'SELECT ''a''::tsquery, plainto_tsquery(${inner}) FROM ${table}')`,
  () => "SELECT owner_hash(1)",
  () => "SELECT * FROM hash_lookup",
]

export interface Case {
  readonly sql: string
  /** Refused because it reads hidden data, or because it calls a function the allowlist refuses. */
  readonly refuse: boolean
}

export function generate(random: () => number, count: number): Case[] {
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)]
    if (item === undefined) throw new Error("empty choice")
    return item
  }
  const cases: Case[] = []
  while (cases.length < count) {
    if (random() < 0.12) {
      const [inner, table] = pick(INNER)
      cases.push({ sql: pick(STRING_SQL)(inner, table), refuse: true })
      continue
    }
    const from = pick(SOURCES)
    const used = pick(from.columns)
    const shape = random()
    let projection: string
    let hidden = from.hidden || used.hidden
    let aggregate = false
    if (shape < 0.2 && from.rows) {
      projection = pick(WHOLE_ROWS)
      hidden = from.hidden || from.columns.some((c) => c.hidden)
    } else if (shape < 0.45) {
      projection = pick(AGGREGATES)(used.expr)
      aggregate = true
    } else {
      projection = pick(SCALARS)(used.expr)
    }
    const filtered = pick(from.columns)
    const filter = pick(FILTERS)(filtered.expr)
    if (filter !== "") hidden ||= filtered.hidden
    const order =
      !aggregate && random() < 0.2
        ? { text: ` ORDER BY ${used.expr}::text`, hidden: used.hidden }
        : undefined
    if (order !== undefined) hidden ||= order.hidden
    const query = `SELECT ${projection} AS v FROM ${from.from}${filter}${order?.text ?? ""}`
    cases.push({ sql: pick(WRAPPERS)(query), refuse: hidden })
  }
  return cases
}

// Each pins a bypass an earlier check missed: an alias list, text search over a string, a stored view.
export const KNOWN: readonly Case[] = [
  { sql: "SELECT c FROM users AS t(a, b, c)", refuse: true },
  { sql: "SELECT t.* FROM users AS t(a, b, c)", refuse: true },
  {
    sql: "SELECT word FROM ts_stat('SELECT to_tsvector(''simple'', password_hash) FROM users')",
    refuse: true,
  },
  { sql: "SELECT * FROM secret_copy", refuse: true },
  { sql: "SELECT ph FROM hash_copy", refuse: true },
  { sql: "SELECT note FROM users", refuse: false },
]
