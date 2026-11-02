/**
 * The plan-level layers of `@nifrajs/mcp-db/postgres`: which relations a plan may read, which
 * functions a statement may call, and which masked columns a plan may use. The grant gate
 * (`pg-grants.ts`) makes the database refuse masked and excluded data on its own; the column check
 * here is the second line behind it.
 */

import { type PgConnection, type PlanReads, type PlanRelation, records } from "./pg-exec.ts"
import { type PgCall, tableAliasLists } from "./pg-lexer.ts"
import { type DbRefusal, dbRefusal } from "./shared.ts"

/** Which relations a query may read: `PostgresScope` in the public module. */
export interface RelationScope {
  readonly schemas?: readonly string[]
  readonly exclude?: readonly string[]
}

/** Why a relation is out of scope: outside the allowed schemas, or named in `exclude`. */
export type ScopeRule = (relation: PlanRelation) => "schema" | "exclude" | undefined

export function scopeRule(scope: RelationScope): ScopeRule {
  const schemas = new Set((scope.schemas ?? ["public"]).map((name) => name.toLowerCase()))
  const excluded = new Set((scope.exclude ?? []).map((name) => name.toLowerCase()))
  return ({ schema, name }) => {
    if (!schemas.has(schema.toLowerCase())) return "schema"
    if (excluded.has(name.toLowerCase()) || excluded.has(`${schema}.${name}`.toLowerCase())) {
      return "exclude"
    }
    return undefined
  }
}

function scopeMatcher(scope: RelationScope): (relation: PlanRelation) => string | undefined {
  const rule = scopeRule(scope)
  const schemas = (scope.schemas ?? ["public"]).map((name) => name.toLowerCase())
  return (relation) => {
    const qualified = `${relation.schema}.${relation.name}`
    const ruled = rule(relation)
    if (ruled === "schema") {
      return `the query reads ${qualified}, outside the allowed schemas (${schemas.join(", ")})`
    }
    if (ruled === "exclude")
      return `the query reads ${qualified}, which devDatabase.exclude leaves out`
    return undefined
  }
}

// Built-ins outside the immutable-or-stable, parallel-safe rule that only read values or the clock.
// `age` is here for its xid overload; every other overload of it passes the rule.
const VALUE_FUNCTIONS = new Set([
  "age",
  "current_schema",
  "current_schemas",
  "random",
  "random_normal",
  "clock_timestamp",
  "timeofday",
  "gen_random_uuid",
  "uuidv4",
  "uuidv7",
  "uuid_generate_v4",
  "array_sample",
  "array_shuffle",
  "pg_relation_size",
  "pg_table_size",
  "pg_indexes_size",
  "pg_total_relation_size",
])

/** Why `pg_proc` facts refuse a function, or `undefined` when the allowlist accepts it. */
function functionDenial(row: Record<string, unknown>): string | undefined {
  if (row.definer === true) {
    return "it runs with its owner's privileges (SECURITY DEFINER), past the role's grants"
  }
  const pure = row.volatility === "i" || row.volatility === "s"
  const shipped =
    row.schema === "pg_catalog" || row.schema === "information_schema" || row.extension === true
  if (shipped) {
    if (VALUE_FUNCTIONS.has(String(row.name))) return undefined
    if (!pure) {
      return "it is volatile, so it can act outside the query (locks, settings, sequences, notifications, files, other sessions or another database)"
    }
    if (row.parallel !== "s") {
      return "it is not parallel safe, so it can run SQL of its own or read session or server state"
    }
    return undefined
  }
  if (row.aggregate === true) {
    return "it is an aggregate this database defines, and its state functions are not checked"
  }
  if (!pure) return "it is volatile, so it can act outside the query"
  return undefined
}

/**
 * The function allowlist. Every function a call can resolve to (each overload, in the named schema or
 * on the search path) is looked up in `pg_proc` and must pass: a built-in or extension function that
 * is immutable or stable and parallel safe, or one of {@link VALUE_FUNCTIONS}; a function this database
 * defines that is immutable or stable and not SECURITY DEFINER (it runs with the role's grants). A
 * name in `allow` (`name` or `schema.name`) passes whatever it is. A name no function has is dropped:
 * the server will not resolve it either.
 */
export async function functionRefusal(
  connection: PgConnection,
  calls: readonly PgCall[],
  allow: readonly string[] | undefined,
): Promise<DbRefusal | undefined> {
  if (calls.length === 0) return undefined
  // `to_jsonb(p)` reads prokind (11+) or proisagg (10) without naming a column one of them lacks.
  // The names go in as a `name[]` so the lookup is an index probe, not a scan of pg_proc.
  const rows = records(
    await connection`
    SELECT n.nspname::text AS schema, p.proname::text AS name, p.provolatile::text AS volatility,
      p.proparallel::text AS parallel, p.prosecdef AS definer,
      (pg_catalog.to_jsonb(p) ->> 'prokind') = 'a' OR (pg_catalog.to_jsonb(p) ->> 'proisagg') = 'true' AS aggregate,
      EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid
          AND d.refclassid = 'pg_catalog.pg_extension'::regclass AND d.deptype = 'e') AS extension,
      n.nspname = ANY(pg_catalog.current_schemas(true)) AS visible
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = ANY(ARRAY(SELECT pg_catalog.json_array_elements_text(${calls.map((call) => call.name)}::json))::name[])
    ORDER BY n.nspname::text COLLATE "C", p.proname::text COLLATE "C"`,
  )
  const resolves = (row: Record<string, unknown>): boolean =>
    calls.some(
      (call) =>
        call.name === row.name &&
        (call.schema === null ? row.visible === true : call.schema === row.schema),
    )
  const allowed = new Set((allow ?? []).map((name) => name.toLowerCase()))
  for (const row of rows) {
    if (!resolves(row)) continue
    const reason = functionDenial(row)
    if (reason === undefined) continue
    const qualified = `${String(row.schema)}.${String(row.name)}`
    if (allowed.has(String(row.name).toLowerCase()) || allowed.has(qualified.toLowerCase())) {
      continue
    }
    return dbRefusal("NIFRA_DB_FUNCTION_REFUSED", `the query calls ${qualified}(): ${reason}`)
  }
  return undefined
}

const callKey = (call: PgCall): string => JSON.stringify([call.schema, call.name])

/** What {@link checkScope} needs besides the scope. */
export interface ScopeCheckOptions {
  /** True for a column name `redaction.column` masks. */
  readonly masked?: ((column: string) => boolean) | undefined
  /** The caller's statement, for the table alias lists the plan cannot show. */
  readonly statement: string
  readonly allowFunctions?: readonly string[] | undefined
  /** Calls the statement's own text named, already looked up before planning. */
  readonly checkedCalls?: readonly PgCall[]
}

/**
 * The plan-level check: each relation, and every table it inherits from (partitions too). A `pg_*`
 * function in FROM reads server state the way a catalog does - a system view such as
 * `pg_stat_activity` plans as one once the planner drops its catalog joins - so it is out of scope too.
 * Every function the plan calls (inside views too) goes through the allowlist. With `masked`, a plan
 * expression that uses a masked column, or a whole row holding one, is refused, and so is any masked
 * column of a relation `statement` reads when it gives a table a column alias list.
 */
export function checkScope(scope: RelationScope, options: ScopeCheckOptions) {
  const outOfScope = scopeMatcher(scope)
  const { masked, statement } = options
  const checked = new Set((options.checkedCalls ?? []).map(callKey))
  return async (connection: PgConnection, reads: PlanReads): Promise<DbRefusal | undefined> => {
    for (const fn of reads.functions) {
      if (fn.schema === "pg_catalog" && fn.name.toLowerCase().startsWith("pg_")) {
        return dbRefusal(
          "NIFRA_DB_TABLE_EXCLUDED",
          `the query reads server state through ${fn.schema}.${fn.name}(), a system catalog function`,
        )
      }
    }
    const { relations } = reads
    for (const relation of relations) {
      const reason = outOfScope(relation)
      if (reason !== undefined) return dbRefusal("NIFRA_DB_TABLE_EXCLUDED", reason)
    }
    const calls = reads.calls.filter((call) => !checked.has(callKey(call)))
    const refusedCall = await functionRefusal(connection, calls, options.allowFunctions)
    if (refusedCall !== undefined) return refusedCall
    if (relations.length === 0) return undefined
    const ancestors = records(
      await connection`
      WITH RECURSIVE planned AS (
        SELECT pg_catalog.to_regclass(pg_catalog.quote_ident(r.schema) || '.' || pg_catalog.quote_ident(r.name))::oid AS oid
        FROM pg_catalog.json_to_recordset(${[...relations]}::json) AS r(schema text, name text)
      ), up(oid) AS (
        SELECT i.inhparent FROM pg_catalog.pg_inherits i JOIN planned p ON i.inhrelid = p.oid
        UNION
        SELECT i.inhparent FROM pg_catalog.pg_inherits i JOIN up ON i.inhrelid = up.oid
      )
      SELECT n.nspname::text AS schema, c.relname::text AS name
      FROM up JOIN pg_catalog.pg_class c ON c.oid = up.oid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`,
    )
    for (const row of ancestors) {
      const reason = outOfScope({ schema: String(row.schema), name: String(row.name) })
      if (reason !== undefined) return dbRefusal("NIFRA_DB_TABLE_EXCLUDED", reason)
    }
    if (masked === undefined) return undefined
    const hits = new Set<string>()
    const wholeRows: PlanRelation[] = []
    for (const { relation, column } of reads.columns) {
      if (column === "*") wholeRows.push(relation)
      else if (masked(column)) hits.add(`${relation.name}.${column}`)
    }
    // The plan names an alias-listed scan's columns by the list, which can reuse a real column's name.
    const renamed = tableAliasLists(statement)
    if (renamed.length > 0) wholeRows.push(...reads.relations)
    const listed = [...wholeRows, ...reads.outputs.map((output) => output.relation)]
    if (listed.length > 0) {
      const live = new Map<string, string[]>()
      const rows = records(
        await connection`
        SELECT r.schema, r.name, a.attname::text AS column
        FROM pg_catalog.json_to_recordset(${listed}::json) AS r(schema text, name text)
        JOIN pg_catalog.pg_attribute a
          ON a.attrelid = pg_catalog.to_regclass(pg_catalog.quote_ident(r.schema) || '.' || pg_catalog.quote_ident(r.name))
        WHERE a.attnum > 0 AND NOT a.attisdropped`,
      )
      for (const row of rows) {
        const key = `${String(row.schema)}.${String(row.name)}`
        live.set(key, [...(live.get(key) ?? []), String(row.column)])
      }
      const columnsOf = (relation: PlanRelation): readonly string[] =>
        live.get(`${relation.schema}.${relation.name}`) ?? []
      for (const relation of wholeRows) {
        for (const column of columnsOf(relation))
          if (masked(column)) hits.add(`${relation.name}.${column}`)
      }
      for (const output of reads.outputs) {
        const all = columnsOf(output.relation)
        // Every column is the physical target list: the parent's expressions say what it uses.
        if (all.length > 0 && all.every((column) => output.columns.includes(column))) continue
        for (const column of output.columns)
          if (masked(column)) hits.add(`${output.relation.name}.${column}`)
      }
    }
    if (hits.size === 0) return undefined
    const [aliased] = renamed
    if (aliased !== undefined) {
      return dbRefusal(
        "NIFRA_DB_COLUMN_REFUSED",
        `the query renames the columns of ${aliased.table} with the alias list ${aliased.alias}(...), so the plan cannot show which columns it reads, and it reads a relation holding ${[...hits].join(", ")}, masked as ${hits.size === 1 ? "a credential" : "credentials"}; alias columns in the select list instead`,
      )
    }
    return dbRefusal(
      "NIFRA_DB_COLUMN_REFUSED",
      `the query reads ${[...hits].join(", ")}, masked as ${hits.size === 1 ? "a credential" : "credentials"}`,
    )
  }
}
