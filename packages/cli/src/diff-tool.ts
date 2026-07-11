/**
 * `nifra snapshot` / `nifra diff` — the API breaking-change gate.
 *
 *   nifra snapshot [--out api-snapshot.json]   Write the backend's route contract as plain JSON.
 *   nifra diff <baseline.json> [--json]        Re-snapshot and compare against the committed
 *                                              baseline; exit non-zero on any breaking change.
 *
 * The CI loop: commit a snapshot on main, run `nifra diff api-snapshot.json` on every PR, and an
 * accidental contract break (removed route, new required field, retyped response) fails the build
 * before it ships. Classification lives in `@nifrajs/core/diff` (direction-aware, fails closed);
 * this module only loads `backend.ts` and renders the result.
 *
 * Loads ONLY `backend.ts` — the API contract — so it works on an API-only project with no
 * framework config or routes/ directory (unlike the eager `loadApp`).
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import {
  diffRouteSnapshots,
  type RouteChange,
  type RouteSnapshot,
  type RoutesDiff,
  snapshotRoutes,
} from "@nifrajs/core/diff"

/** Snapshot file envelope — versioned so a future format change can migrate instead of misparse. */
export interface SnapshotFile {
  readonly nifraSnapshot: 1
  readonly routes: readonly RouteSnapshot[]
}

export const DEFAULT_SNAPSHOT_FILE = "api-snapshot.json"

/** Parse + validate a snapshot file's content. Throws with an actionable message on any mismatch. */
export function parseSnapshotFile(content: string, sourcePath: string): SnapshotFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(
      `[nifra] ${sourcePath} is not valid JSON — regenerate it with \`nifra snapshot\`.`,
    )
  }
  const record = parsed as Partial<SnapshotFile> | null
  if (
    record === null ||
    typeof record !== "object" ||
    record.nifraSnapshot !== 1 ||
    !Array.isArray(record.routes)
  ) {
    throw new Error(
      `[nifra] ${sourcePath} is not a nifra API snapshot — expected { "nifraSnapshot": 1, "routes": [...] }.`,
    )
  }
  return record as SnapshotFile
}

const SEVERITY_MARK = {
  breaking: "✖ breaking",
  compatible: "✓ compatible",
  info: "ℹ info",
} as const

const describeChange = (change: RouteChange): string => {
  const where = change.section === "route" ? "" : ` ${change.section}`
  return `${SEVERITY_MARK[change.severity]}  ${change.method} ${change.path}${where}: ${change.message}`
}

/** Render a diff for terminals: breaking first, then info, then compatible. */
export function formatDiff(diff: RoutesDiff): string {
  if (diff.changes.length === 0) return "No API contract changes."
  const order: Record<RouteChange["severity"], number> = { breaking: 0, info: 1, compatible: 2 }
  const lines = [...diff.changes]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map(describeChange)
  const breaking = diff.changes.filter((change) => change.severity === "breaking").length
  const summary = diff.hasBreaking
    ? `${breaking} breaking change${breaking === 1 ? "" : "s"} — existing clients will fail.`
    : "No breaking changes."
  return `${lines.join("\n")}\n\n${summary}`
}

/** Import `backend.ts` from `cwd` and snapshot its routes. */
async function snapshotBackend(cwd: string): Promise<readonly RouteSnapshot[]> {
  const backendPath = resolve(cwd, "backend.ts")
  if (!existsSync(backendPath)) {
    throw new Error(
      `[nifra] no backend.ts in ${cwd} — \`nifra snapshot\`/\`nifra diff\` compare the API contract, which lives in backend.ts.`,
    )
  }
  const backend = ((await import(backendPath)) as { backend?: unknown }).backend
  if (backend === undefined) {
    throw new Error(`[nifra] ${backendPath} does not export \`backend\`.`)
  }
  return snapshotRoutes(backend)
}

/** `nifra snapshot`: write the current contract as the CI baseline. */
export async function runSnapshot(cwd: string, options: { out?: string }): Promise<void> {
  const routes = await snapshotBackend(cwd)
  const file: SnapshotFile = { nifraSnapshot: 1, routes }
  const outPath = resolve(cwd, options.out ?? DEFAULT_SNAPSHOT_FILE)
  await Bun.write(outPath, `${JSON.stringify(file, null, 2)}\n`)
  console.log(`[nifra] wrote ${routes.length} route${routes.length === 1 ? "" : "s"} to ${outPath}`)
}

/** `nifra diff`: compare the current contract against a baseline. Returns false on breaking changes. */
export async function runDiff(
  cwd: string,
  baselinePath: string,
  options: { json?: boolean },
): Promise<boolean> {
  const resolved = resolve(cwd, baselinePath)
  const baselineFile = Bun.file(resolved)
  if (!(await baselineFile.exists())) {
    throw new Error(
      `[nifra] baseline not found: ${resolved} — create it on your main branch with \`nifra snapshot\`.`,
    )
  }
  const baseline = parseSnapshotFile(await baselineFile.text(), baselinePath)
  const current = await snapshotBackend(cwd)
  const diff = diffRouteSnapshots(baseline.routes, current)
  if (options.json === true) {
    console.log(JSON.stringify({ hasBreaking: diff.hasBreaking, changes: diff.changes }, null, 2))
  } else {
    console.log(formatDiff(diff))
  }
  return !diff.hasBreaking
}
