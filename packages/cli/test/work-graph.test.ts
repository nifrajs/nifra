import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"
import {
  buildProjectWorkGraph,
  createEvidenceBundle,
  evaluateBuildFreshness,
  queryImpact,
  recordProof,
  type WorkGraphSourceFile,
} from "../src/work-graph.ts"

const backend = server().post(
  "/orders",
  {
    body: t.object({ name: t.string() }),
    response: t.object({ ok: t.boolean() }),
    capabilities: ["orders.write"],
  },
  () => ({ ok: true }),
)

const files: readonly WorkGraphSourceFile[] = [
  { path: "backend.ts", content: 'export const backend = server().post("/orders", ...)' },
  { path: "routes/orders.ts", content: 'export const route = "/orders"' },
  { path: "routes/orders.test.ts", kind: "test", content: 'test("POST /orders", ...)' },
  { path: "server-manifest.ts", kind: "manifest", content: 'routes: ["/orders"]' },
]

describe("verification work graph", () => {
  test("connects routes to schemas, capabilities, tests, and manifests", async () => {
    const result = await buildProjectWorkGraph(
      { source: backend, files, freshness: { ok: true } },
      { changedFiles: ["routes/orders.ts"], minLevel: 1 },
    )
    expect(result.graph.version).toBe(1)
    expect(result.graph.nodes.some((node) => node.id === "route:POST /orders")).toBe(true)
    expect(result.graph.nodes.some((node) => node.id === "schema:POST /orders:body")).toBe(true)
    expect(result.graph.nodes.some((node) => node.id === "capability:orders.write")).toBe(true)
    expect(result.graph.edges).toContainEqual({
      from: "test:routes/orders.test.ts",
      to: "route:POST /orders",
      relation: "tests",
    })
    expect(result.graph.edges).toContainEqual({
      from: "manifest:server-manifest.ts",
      to: "route:POST /orders",
      relation: "describes",
    })
    expect(result.impact.impactedRoutes).toEqual(["POST /orders"])
    expect(result.plan.steps.map((step) => step.kind)).toEqual(["typecheck", "contract"])
    expect(result.evidence.stop.done).toBe(false)
    expect(result.evidence.stop.next?.command).toBe("nifra check --lints-only")

    const initial = createEvidenceBundle(result.graph, result.impact, result.plan)
    const typecheck = result.plan.steps[0]!
    const afterTypecheck = recordProof(initial, {
      id: typecheck.id,
      status: "pass",
      level: typecheck.level,
      nodeIds: typecheck.nodeIds,
      command: typecheck.command,
    })
    expect(afterTypecheck.stop.next?.id).toBe("proof:contract")
    const contract = result.plan.steps[1]!
    const complete = recordProof(afterTypecheck, {
      id: contract.id,
      status: "pass",
      level: contract.level,
      nodeIds: contract.nodeIds,
      command: contract.command,
    })
    expect(complete.stop.done).toBe(true)
  })

  test("a higher-level proof never subsumes a lower-level step", async () => {
    const result = await buildProjectWorkGraph(
      { source: backend, files, freshness: { ok: true } },
      { changedFiles: ["routes/orders.ts"], minLevel: 1 },
    )
    const contract = result.plan.steps.find((step) => step.kind === "contract")!
    const initial = createEvidenceBundle(result.graph, result.impact, result.plan)
    const afterContract = recordProof(initial, {
      id: contract.id,
      status: "pass",
      level: contract.level,
      nodeIds: contract.nodeIds,
      command: contract.command,
    })
    expect(afterContract.stop.done).toBe(false)
    expect(afterContract.stop.next?.id).toBe("proof:typecheck")
    expect(afterContract.stop.missing).toContain("nifra check --lints-only")
  })

  test("backend changes conservatively impact every reflected route", async () => {
    const result = await buildProjectWorkGraph(
      { source: backend, files, freshness: { ok: true } },
      { changedFiles: ["backend.ts"] },
    )
    expect(queryImpact(result.graph, ["backend.ts"]).impactedRoutes).toEqual(["POST /orders"])
  })

  test("freshness refuses missing and stale builds", () => {
    expect(
      evaluateBuildFreshness({ hasArtifact: false, newestSourceMs: 3, newestBuildMs: 0 }).reason,
    ).toContain("nifra build")
    expect(
      evaluateBuildFreshness({ hasArtifact: true, newestSourceMs: 4, newestBuildMs: 4 }).reason,
    ).toContain("stale")
    expect(
      evaluateBuildFreshness({ hasArtifact: true, newestSourceMs: 3, newestBuildMs: 4 }).ok,
    ).toBe(true)
  })
})
