/**
 * The grant layer of `@nifrajs/mcp-db/postgres`: what the connected role itself may read of the data
 * the declaration hides. Masked columns, excluded tables and the views that read either must be refused
 * by the database's privileges, not only by the plan check, because a function or a materialized view
 * reads data the plan never shows, and a SECURITY DEFINER function reads past the grants, so the role
 * may not execute one. One catalog read serves both the gate, which refuses a role that can still read
 * hidden data, and the role SQL, which writes the grants that make it unable to.
 */

import { type PgConnection, type PlanRelation, records } from "./pg-exec.ts"
import { type RelationScope, scopeRule } from "./pg-scope.ts"
import { type DbRefusal, dbRefusal } from "./shared.ts"

/** A relation of the allowed schemas, with what the connected role may read of it. */
export interface Exposure {
  readonly relation: PlanRelation
  /** `pg_class.relkind`: r, p, v, m or f. */
  readonly kind: string
  readonly columns: readonly { readonly name: string; readonly readable: boolean }[]
  /** The role may read at least one column. */
  readonly readable: boolean
  /** Every table it inherits from, partition parents included. */
  readonly ancestors: readonly PlanRelation[]
  /**
   * For a view or materialized view, every base column its definition reads; a whole-row read lists
   * each column of the relation, and `null` stands for a relation with no columns.
   */
  readonly reads: readonly { readonly relation: PlanRelation; readonly column: string | null }[]
}

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

const jsonValues = (value: unknown): unknown[] => {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value
  return Array.isArray(parsed) ? parsed : []
}

/** Read every relation of the allowed schemas, partitions and views included, with its privileges. */
export async function readExposure(
  connection: PgConnection,
  schemas: readonly string[],
): Promise<Exposure[]> {
  // A view's rule depends on each column it reads; on the relation as a whole only for a whole-row read.
  // Set-based, not a JSON pair per column: this runs before every query, over every relation in scope.
  const rows = records(
    await connection`
    WITH RECURSIVE rel AS (
      SELECT c.oid, n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS kind,
        pg_catalog.has_table_privilege(c.oid, 'SELECT') AS whole
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname = ANY(ARRAY(SELECT pg_catalog.json_array_elements_text(${[...schemas]}::json)))
    ), up(child, parent) AS (
      SELECT i.inhrelid, i.inhparent FROM pg_catalog.pg_inherits i
      UNION
      SELECT up.child, i.inhparent FROM up JOIN pg_catalog.pg_inherits i ON i.inhrelid = up.parent
    )
    SELECT r.schema, r.name, r.kind, pg_catalog.has_any_column_privilege(r.oid, 'SELECT') AS readable,
      cols.names, cols.granted,
      (SELECT to_json(array_agg(pg_catalog.json_build_array(pn.nspname::text, pc.relname::text)))
        FROM up JOIN pg_catalog.pg_class pc ON pc.oid = up.parent
        JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace WHERE up.child = r.oid) AS ancestors,
      CASE WHEN r.kind IN ('v', 'm') THEN (
        SELECT to_json(array_agg(DISTINCT pg_catalog.jsonb_build_array(rn.nspname::text, rc.relname::text, a.attname::text)))
        FROM pg_catalog.pg_rewrite w
        JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.objid = w.oid
          AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid <> r.oid
        JOIN pg_catalog.pg_class rc ON rc.oid = d.refobjid
        JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum > 0
          AND NOT a.attisdropped AND (d.refobjsubid = 0 OR a.attnum = d.refobjsubid)
        WHERE w.ev_class = r.oid) END AS reads
    FROM rel r
    LEFT JOIN LATERAL (
      SELECT to_json(array_agg(a.attname::text ORDER BY a.attnum)) AS names,
        to_json(array_agg(r.whole OR pg_catalog.has_column_privilege(r.oid, a.attnum, 'SELECT') ORDER BY a.attnum)) AS granted
      FROM pg_catalog.pg_attribute a WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
    ) AS cols ON true
    ORDER BY r.schema COLLATE "C", r.name COLLATE "C"`,
  )
  return rows.map((row) => {
    const granted = jsonValues(row.granted)
    return {
      relation: { schema: String(row.schema), name: String(row.name) },
      kind: String(row.kind),
      readable: row.readable === true,
      columns: asStrings(jsonValues(row.names)).map((name, index) => ({
        name,
        readable: granted[index] === true,
      })),
      ancestors: jsonValues(row.ancestors).flatMap((pair) => {
        const [schema, name] = asStrings(pair)
        return schema === undefined || name === undefined ? [] : [{ schema, name }]
      }),
      reads: jsonValues(row.reads).flatMap((triple) => {
        if (!Array.isArray(triple)) return []
        const [schema, name, column] = triple
        if (typeof schema !== "string" || typeof name !== "string") return []
        return [{ relation: { schema, name }, column: typeof column === "string" ? column : null }]
      }),
    }
  })
}

const keyOf = (relation: PlanRelation): string => JSON.stringify([relation.schema, relation.name])
const named = (relation: PlanRelation): string => `${relation.schema}.${relation.name}`

/** What the declaration hides of each relation. */
export interface ExposureVerdict {
  /** Relations hidden whole, with why: excluded, inheriting from an excluded one, or a view reading hidden data. */
  readonly hidden: ReadonlyMap<string, string>
  /** The masked columns of each relation that is not hidden. */
  readonly masked: ReadonlyMap<string, readonly string[]>
  /** The key {@link ExposureVerdict.hidden} and {@link ExposureVerdict.masked} use for a relation. */
  readonly key: (relation: PlanRelation) => string
}

/**
 * Decide what is hidden. A view or materialized view reads with its owner's privileges, so one that
 * reads a masked column, an excluded or hidden relation, or anything outside the allowed schemas is
 * hidden whole: which of its columns carries the data is not recorded anywhere.
 */
export function judgeExposure(
  exposures: readonly Exposure[],
  scope: RelationScope,
  masked: ((column: string) => boolean) | undefined,
): ExposureVerdict {
  const rule = scopeRule(scope)
  const hidden = new Map<string, string>()
  for (const exposure of exposures) {
    if (rule(exposure.relation) === "exclude") {
      hidden.set(keyOf(exposure.relation), "devDatabase.exclude leaves it out")
      continue
    }
    const parent = exposure.ancestors.find((ancestor) => rule(ancestor) === "exclude")
    if (parent !== undefined) {
      hidden.set(
        keyOf(exposure.relation),
        `it inherits from ${named(parent)}, which devDatabase.exclude leaves out`,
      )
    }
  }
  const taint = (exposure: Exposure): string | undefined => {
    for (const { relation, column } of exposure.reads) {
      const reads = `it is a view that reads ${named(relation)}`
      if (hidden.has(keyOf(relation))) return `${reads}, which is hidden`
      const ruled = rule(relation)
      if (ruled === "exclude") return `${reads}, which devDatabase.exclude leaves out`
      if (ruled === "schema") return `${reads}, outside the allowed schemas`
      if (column !== null && masked?.(column) === true) {
        return `it is a view that reads ${named(relation)}.${column}, masked as a credential`
      }
    }
    return undefined
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const exposure of exposures) {
      if (exposure.reads.length === 0 || hidden.has(keyOf(exposure.relation))) continue
      const reason = taint(exposure)
      if (reason !== undefined) {
        hidden.set(keyOf(exposure.relation), reason)
        changed = true
      }
    }
  }
  const maskedColumns = new Map<string, readonly string[]>()
  if (masked !== undefined) {
    for (const exposure of exposures) {
      if (hidden.has(keyOf(exposure.relation))) continue
      const columns = exposure.columns.filter((column) => masked(column.name)).map((c) => c.name)
      if (columns.length > 0) maskedColumns.set(keyOf(exposure.relation), columns)
    }
  }
  return { hidden, masked: maskedColumns, key: keyOf }
}

const LISTED = 4

/** A relation as a whole (`column` null) or one of its columns. */
export interface GrantTarget {
  readonly relation: PlanRelation
  readonly column: string | null
}

/** Hidden data the role may read: a relation hidden whole or a masked column. */
export interface HiddenReach extends GrantTarget {
  readonly reason: string
}

/** What the role may itself read of what the verdict hides. */
export function hiddenReach(
  exposures: readonly Exposure[],
  verdict: ExposureVerdict,
): HiddenReach[] {
  const reach: HiddenReach[] = []
  for (const exposure of exposures) {
    const key = verdict.key(exposure.relation)
    const reason = verdict.hidden.get(key)
    if (reason !== undefined) {
      if (exposure.readable) reach.push({ relation: exposure.relation, column: null, reason })
      continue
    }
    const masked = new Set(verdict.masked.get(key) ?? [])
    for (const column of exposure.columns) {
      if (column.readable && masked.has(column.name)) {
        reach.push({
          relation: exposure.relation,
          column: column.name,
          reason: "masked as a credential",
        })
      }
    }
  }
  return reach
}

/** A grant through which a role holds a privilege. */
export interface Held {
  /** `null` is PUBLIC. */
  readonly grantee: string | null
  /** The column a column-level grant covers; `null` for a grant on the whole object. */
  readonly column: string | null
  /** Held as a member of `pg_read_all_data`, which no REVOKE on the object removes. */
  readonly member: boolean
}

/** The grants each object is held through, keyed by {@link reachKey} or {@link definerLabel}. */
export type HeldBy = ReadonlyMap<string, readonly Held[]>

export const reachKey = (target: GrantTarget): string =>
  JSON.stringify([target.relation.schema, target.relation.name, target.column])

const holders = (held: readonly Held[] | undefined): string => {
  const names = new Set(
    (held ?? []).map((grant) =>
      grant.grantee === null ? "PUBLIC" : JSON.stringify(grant.grantee),
    ),
  )
  return names.size === 0 ? "" : `granted to ${[...names].join(", ")}`
}

const grantsOf = (privilege: string, what: string): string =>
  `revoke each grant that gives the role ${privilege} on ${what} (to PUBLIC, to the role, or to a role whose privileges it has)`

/** Refuse a role that may itself read anything the verdict hides, naming the grants it reads through. */
export function grantRefusal(
  role: string,
  reach: readonly HiddenReach[],
  held?: HeldBy,
): DbRefusal | undefined {
  const readable = reach.map((reach) => {
    const via = holders(held?.get(reachKey(reach)))
    const label = `${named(reach.relation)}${reach.column === null ? "" : `.${reach.column}`}`
    return `${label} (${reach.reason}${via === "" ? "" : `; ${via}`})`
  })
  if (readable.length === 0) return undefined
  const more = readable.length > LISTED ? `, and ${readable.length - LISTED} more` : ""
  return dbRefusal(
    "NIFRA_DB_ROLE_GRANTS",
    `role ${JSON.stringify(role)} may read ${readable.slice(0, LISTED).join(", ")}${more}; the database must refuse what the declaration hides, so ${grantsOf("SELECT", "it")} or connect as a role that cannot read it`,
  )
}

const grantee = (value: unknown): string | null => (typeof value === "string" ? value : null)

/**
 * The grants through which `role` holds SELECT on each target: on the relation, on a column (every
 * column for a relation hidden whole), or as a member of `pg_read_all_data`. Only PUBLIC's grants
 * when `role` is null, as for a role not created yet. Read for a refusal and for the role SQL, not
 * before each query: a REVOKE from one grantee leaves the role every other path.
 */
export async function readSelectGrants(
  connection: PgConnection,
  role: string | null,
  targets: readonly GrantTarget[],
): Promise<HeldBy> {
  if (targets.length === 0) return new Map()
  const listed = targets.map((target) => [
    target.relation.schema,
    target.relation.name,
    target.column,
  ])
  const rows = records(
    await connection`
    WITH target AS (
      SELECT t ->> 0 AS schema, t ->> 1 AS name, t ->> 2 AS col
      FROM pg_catalog.json_array_elements(${listed}::json) t
    ), rel AS (
      SELECT target.schema, target.name, target.col, c.oid, c.relacl, c.relowner
      FROM target JOIN pg_catalog.pg_namespace n ON n.nspname = target.schema
      JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = target.name
    ), held AS (
      SELECT rel.schema, rel.name, rel.col, NULL::text AS granted, g.grantee, false AS member
      FROM rel CROSS JOIN LATERAL
        pg_catalog.aclexplode(COALESCE(rel.relacl, pg_catalog.acldefault('r', rel.relowner))) g
      WHERE g.privilege_type = 'SELECT'
      UNION ALL
      SELECT rel.schema, rel.name, rel.col, a.attname::text, g.grantee, false
      FROM rel JOIN pg_catalog.pg_attribute a ON a.attrelid = rel.oid AND a.attnum > 0
        AND NOT a.attisdropped AND (rel.col IS NULL OR a.attname = rel.col)
      CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) g
      WHERE g.privilege_type = 'SELECT'
      UNION ALL
      SELECT rel.schema, rel.name, rel.col, NULL, r.oid, true
      FROM rel JOIN pg_catalog.pg_roles r ON r.rolname = 'pg_read_all_data'
    )
    SELECT * FROM (
      SELECT DISTINCT schema, name, col, granted, member,
        CASE WHEN grantee = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(grantee)::text END AS holder
      FROM held
      WHERE grantee = 0 OR pg_catalog.pg_has_role(${role}::text::name, grantee, 'USAGE')
    ) d
    ORDER BY d.schema COLLATE "C", d.name COLLATE "C", d.col COLLATE "C" NULLS FIRST,
      d.holder COLLATE "C" NULLS FIRST, d.granted COLLATE "C" NULLS FIRST`,
  )
  const held = new Map<string, Held[]>()
  for (const row of rows) {
    const key = reachKey({
      relation: { schema: String(row.schema), name: String(row.name) },
      column: grantee(row.col),
    })
    const list = held.get(key) ?? []
    list.push({
      grantee: grantee(row.holder),
      column: grantee(row.granted),
      member: row.member === true,
    })
    held.set(key, list)
  }
  return held
}

/** A function the role may execute that runs SECURITY DEFINER code: its own body or, for an aggregate, a support function's. */
export interface Definer {
  readonly schema: string
  readonly name: string
  /** As `pg_get_function_identity_arguments` writes them. */
  readonly args: string
}

/**
 * Every function that `grantee` may execute and that runs with its owner's rights, `pg_catalog`
 * included, where a stock server has none. Such a function reads past every grant wherever it is
 * reached: by name, through an operator or a cast, folded into a view at plan time, or from another
 * function's body. The server checks the caller's EXECUTE on each of those paths, except an
 * aggregate's support functions, which it checks against the aggregate's owner, so an aggregate over
 * one is listed in its place. A procedure is left out: no expression can call one.
 */
export async function readDefiners(
  connection: PgConnection,
  grantee: string,
): Promise<readonly Definer[]> {
  const rows = records(
    await connection`
    WITH reach AS (
      SELECT p.oid FROM pg_catalog.pg_proc p
      WHERE p.prosecdef AND (pg_catalog.to_jsonb(p) ->> 'prokind') IS DISTINCT FROM 'p'
      UNION
      SELECT a.aggfnoid FROM pg_catalog.pg_aggregate a
      JOIN pg_catalog.pg_proc s ON s.prosecdef AND s.oid IN (a.aggtransfn, a.aggfinalfn,
        a.aggcombinefn, a.aggserialfn, a.aggdeserialfn, a.aggmtransfn, a.aggminvtransfn, a.aggmfinalfn)
    )
    SELECT n.nspname::text AS schema, p.proname::text AS name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
    FROM reach JOIN pg_catalog.pg_proc p ON p.oid = reach.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE pg_catalog.has_function_privilege(${grantee}::text::name, p.oid, 'EXECUTE')
    ORDER BY n.nspname::text COLLATE "C", p.proname::text COLLATE "C",
      pg_catalog.pg_get_function_identity_arguments(p.oid) COLLATE "C"`,
  )
  return rows.map((row) => ({
    schema: String(row.schema),
    name: String(row.name),
    args: String(row.args),
  }))
}

/** The definers `allow` (`name` or `schema.name`, as `allowFunctions` takes them) does not accept. */
export function unacceptedDefiners(
  definers: readonly Definer[],
  allow: readonly string[] | undefined,
): readonly Definer[] {
  const allowed = new Set((allow ?? []).map((name) => name.toLowerCase()))
  return definers.filter(
    (definer) =>
      !allowed.has(definer.name.toLowerCase()) &&
      !allowed.has(`${definer.schema}.${definer.name}`.toLowerCase()),
  )
}

export const definerLabel = (definer: Definer): string =>
  `${definer.schema}.${definer.name}(${definer.args})`

/**
 * The grants through which `role` holds EXECUTE on each definer, keyed by {@link definerLabel}; only
 * PUBLIC's when `role` is null. Read for a refusal and for the role SQL, like {@link readSelectGrants}.
 */
export async function readExecuteGrants(
  connection: PgConnection,
  role: string | null,
  definers: readonly Definer[],
): Promise<HeldBy> {
  if (definers.length === 0) return new Map()
  const listed = definers.map((definer) => [definer.schema, definer.name, definer.args])
  const rows = records(
    await connection`
    SELECT * FROM (
      SELECT DISTINCT n.nspname::text AS schema, p.proname::text AS name,
        pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
        CASE WHEN g.grantee = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(g.grantee)::text END AS holder
      FROM pg_catalog.json_array_elements(${listed}::json) t
      JOIN pg_catalog.pg_namespace n ON n.nspname = t ->> 0
      JOIN pg_catalog.pg_proc p ON p.pronamespace = n.oid AND p.proname = t ->> 1
        AND pg_catalog.pg_get_function_identity_arguments(p.oid) = t ->> 2
      CROSS JOIN LATERAL
        pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
      WHERE g.privilege_type = 'EXECUTE'
        AND (g.grantee = 0 OR pg_catalog.pg_has_role(${role}::text::name, g.grantee, 'USAGE'))
    ) d
    ORDER BY d.schema COLLATE "C", d.name COLLATE "C", d.args COLLATE "C", d.holder COLLATE "C" NULLS FIRST`,
  )
  const held = new Map<string, Held[]>()
  for (const row of rows) {
    const key = definerLabel({
      schema: String(row.schema),
      name: String(row.name),
      args: String(row.args),
    })
    const list = held.get(key) ?? []
    list.push({ grantee: grantee(row.holder), column: null, member: false })
    held.set(key, list)
  }
  return held
}

/** Refuse a role that may execute SECURITY DEFINER code `allow` does not accept, naming the grants. */
export function definerRefusal(
  role: string,
  definers: readonly Definer[],
  allow: readonly string[] | undefined,
  held?: HeldBy,
): DbRefusal | undefined {
  const open = unacceptedDefiners(definers, allow).map((definer) => {
    const label = definerLabel(definer)
    const via = holders(held?.get(label))
    return via === "" ? label : `${label} (${via})`
  })
  if (open.length === 0) return undefined
  const more = open.length > LISTED ? `, and ${open.length - LISTED} more` : ""
  return dbRefusal(
    "NIFRA_DB_ROLE_GRANTS",
    `role ${JSON.stringify(role)} may execute ${open.slice(0, LISTED).join(", ")}${more}, which run SECURITY DEFINER code with their owner's rights wherever a query reaches them (through an operator, a cast, a view or another function), so ${grantsOf("EXECUTE", "them")} or name them in allowFunctions`,
  )
}

/**
 * A server refusal of a relation the role may read only some columns of, as a column refusal that says
 * so. `SELECT *` on a table with a masked column fails this way under the grants `nifra db role` writes.
 */
export function partialGrantRefusal(
  error: unknown,
  exposures: readonly Exposure[],
): DbRefusal | undefined {
  const state =
    typeof error === "object" && error !== null && "errno" in error ? error.errno : undefined
  if (state !== "42501" || !(error instanceof Error)) return undefined
  const denied =
    /permission denied for (?:table|view|materialized view|foreign table|relation) "?([^"\s]+)"?$/.exec(
      error.message,
    )?.[1]
  if (denied === undefined) return undefined
  for (const exposure of exposures) {
    if (exposure.relation.name !== denied || !exposure.readable) continue
    const unreadable = exposure.columns.filter((column) => !column.readable).map((c) => c.name)
    if (unreadable.length === 0) continue
    return dbRefusal(
      "NIFRA_DB_COLUMN_REFUSED",
      `the role may read only some columns of ${named(exposure.relation)}, not ${unreadable.join(", ")}: select the others by name`,
    )
  }
  return undefined
}
