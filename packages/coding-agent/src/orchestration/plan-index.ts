import type { RunNode, RunNodeKind, RunPlan } from "@nifrajs/agent-protocol"
import type { StepCatalog } from "./catalog.ts"

/** A plan's node kinds, idempotency flags and id set, from one walk of its tree. */
export interface PlanIndex {
  readonly kindById: ReadonlyMap<string, RunNodeKind>
  readonly idempotentById: ReadonlyMap<string, boolean>
  readonly nodeIds: ReadonlySet<string>
}

/** Walk the plan tree once: node kinds, idempotency flags, and the full id set. */
export function indexPlan(plan: RunPlan, catalog: StepCatalog): PlanIndex {
  const kindById = new Map<string, RunNodeKind>()
  const idempotentById = new Map<string, boolean>()
  const nodeIds = new Set<string>()
  const walk = (node: RunNode): void => {
    nodeIds.add(node.id)
    kindById.set(node.id, node.kind)
    const step = "step" in node ? catalog.get(node.step) : undefined
    idempotentById.set(node.id, step?.selectEffect !== undefined)
    switch (node.kind) {
      case "sequence":
      case "parallel":
        for (const child of node.children) walk(child)
        break
      case "retry":
        walk(node.child)
        break
      case "branch":
        walk(node.then)
        if (node.otherwise !== undefined) walk(node.otherwise)
        break
    }
  }
  for (const node of plan.nodes) walk(node)
  return { kindById, idempotentById, nodeIds }
}

/** A verify/approve node whose output is not a pass. Other kinds never gate. */
export function isGateRejection(kind: RunNodeKind | undefined, output: unknown): boolean {
  if (kind === "verify") {
    if (output === true) return false
    return !(typeof output === "object" && output !== null && "ok" in output && output.ok === true)
  }
  if (kind === "approve") return output !== true
  return false
}
