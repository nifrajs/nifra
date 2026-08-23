/**
 * The nifra WORST-CASE app - shared verbatim by the Bun, Node, and Deno servers so every
 * runtime section measures the identical app.
 *
 * This app is deliberately constructed to miss EVERY nifra fast tier at once:
 *   - derive + beforeHandle + afterHandle registered  → hookful (generic) lifecycle lane
 *   - multi-segment path params                       → no static-map route hit
 *   - validated query                                 → query materialization + validate
 *   - untrusted JSON body (no trusted-framing mark)   → capped read + parse + validate
 *   - per-request `c.set.headers` writes              → dynamic headers, static-header tier off
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

export function makeWorstNifraApp() {
  return (
    server()
      // Readiness probe only - defined BEFORE the hooks so it stays hook-free; never benched.
      .get("/health", () => ({ ok: true }))
      .derive((c) => ({ requestId: c.header("x-req-id") ?? "none" }))
      .beforeHandle((c) =>
        c.header("x-block") === "1"
          ? Response.json({ error: "blocked" }, { status: 403 })
          : undefined,
      )
      .afterHandle((result) => result)
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
  )
}
