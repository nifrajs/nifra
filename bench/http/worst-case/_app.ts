/**
 * The nifra WORST-CASE app - shared verbatim by the Bun, Node, and Deno servers so every
 * runtime section measures the identical app.
 *
 * This app stresses the hookful route shape. Set BENCH_GENERIC=1 to exclude fusion:
 *   - derive + beforeHandle + afterHandle registered (eligible for the fused hook lane)
 *   - BENCH_GENERIC=1 adds a second before hook and an error hook, selecting the generic lifecycle runner
 *   - multi-segment path params                       → no static-map route hit
 *   - validated query                                 → query materialization + validate
 *   - JSON body validation on the generic body stage → parse + validate after runtime framing
 *   - per-request `c.set.headers` writes              → dynamic headers, static-header tier off
 *
 * Runtime adapters mark requests delivered by the platform HTTP parser as framed; this benchmark
 * therefore measures body parsing + validation, not the separate in-process untrusted-stream path.
 *
 * Value import points at built `dist/` (same reasoning as ../_nifra-app.ts: measure the
 * artifact a real install runs, not live TS source).
 */

import { server } from "../../../packages/core/dist/server.js"
import type {
  StandardResult,
  StandardSchemaV1,
  StandardTypes,
} from "../../../packages/core/src/index.ts"

export interface TaskItem {
  readonly title: string
  readonly done: boolean
  readonly priority: number
  readonly notes: string
}

export interface TaskBatch {
  readonly items: readonly TaskItem[]
}

function isTaskItem(v: unknown): v is TaskItem {
  return (
    typeof v === "object" &&
    v !== null &&
    "title" in v &&
    typeof v.title === "string" &&
    "done" in v &&
    typeof v.done === "boolean" &&
    "priority" in v &&
    typeof v.priority === "number" &&
    "notes" in v &&
    typeof v.notes === "string"
  )
}

/** Full-depth guard: every item's four fields are checked, matching the Elysia TypeBox
 *  schema's semantics exactly - so both frameworks validate the same work. */
export function isTaskBatch(v: unknown): v is TaskBatch {
  if (typeof v !== "object" || v === null || !("items" in v) || !Array.isArray(v.items)) {
    return false
  }
  for (const item of v.items) if (!isTaskItem(item)) return false
  return true
}

export function isTraceQuery(v: unknown): v is { verbose: string; trace: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "verbose" in v &&
    typeof v.verbose === "string" &&
    "trace" in v &&
    typeof v.trace === "string"
  )
}

const taskBatchBody: StandardSchemaV1<unknown, TaskBatch> = {
  "~standard": {
    version: 1,
    vendor: "nifra-bench",
    validate(value): StandardResult<TaskBatch> {
      return isTaskBatch(value)
        ? { value }
        : { issues: [{ message: "expected { items: TaskItem[] }" }] }
    },
    types: undefined as unknown as StandardTypes<unknown, TaskBatch>,
  },
}

const traceQuery: StandardSchemaV1<unknown, { verbose: string; trace: string }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-bench",
    validate(value): StandardResult<{ verbose: string; trace: string }> {
      return isTraceQuery(value)
        ? { value }
        : { issues: [{ message: "expected ?verbose=string&trace=string" }] }
    },
    types: undefined as unknown as StandardTypes<unknown, { verbose: string; trace: string }>,
  },
}

export function makeWorstNifraApp(
  generic = process.env.BENCH_GENERIC === "1",
  protoPoisoning: "reject" | "strip" | "ignore" = "reject",
) {
  const app = server({ protoPoisoning })
    // Readiness probe only - defined BEFORE the hooks so it stays hook-free; never benched.
    .get("/health", () => ({ ok: true }))
    .derive((c) => ({ requestId: c.header("x-req-id") ?? "none" }))
    .beforeHandle((c) =>
      c.header("x-block") === "1"
        ? Response.json({ error: "blocked" }, { status: 403 })
        : undefined,
    )
    .afterHandle((result) => result)
  // The second before hook keeps the work equal to the comparators'; the error hook, which never
  // answers, is what takes the routes off the fused hook lanes.
  if (generic) app.beforeHandle(() => undefined).onError(() => undefined)
  return app
    .get("/orgs/:org/projects/:proj/tasks/:id", { query: traceQuery }, (c) => {
      c.set.headers["x-request-id"] = c.requestId
      c.set.headers["x-trace"] = c.query.trace
      return { org: c.params.org, proj: c.params.proj, id: c.params.id, verbose: c.query.verbose }
    })
    .post("/orgs/:org/projects/:proj/tasks", { body: taskBatchBody }, (c) => {
      c.set.headers["x-request-id"] = c.requestId
      c.set.headers["x-count"] = String(c.body.items.length)
      return {
        org: c.params.org,
        proj: c.params.proj,
        count: c.body.items.length,
        first: c.body.items[0]?.title ?? "",
      }
    })
}
