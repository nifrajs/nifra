import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, open, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"
import { fingerprintBuildInputs, recordBuildProvenance } from "../src/build-provenance.ts"
import {
  buildProjectWorkGraph,
  collectProjectWorkGraph,
  createEvidenceBundle,
  evaluateBuildFreshness,
  inspectBuildFreshness,
  queryImpact,
  recordProof,
  type WorkGraphEdge,
  type WorkGraphSourceFile,
} from "../src/work-graph.ts"
import {
  createFixtureProject,
  createFixtureRoot,
  FIXTURE_TSCONFIG,
  removeFixtureRoot,
  writeAppFile,
} from "./fixture-root.ts"

const fixtures = createFixtureRoot("nifra-prove-")
afterAll(() => removeFixtureRoot(fixtures))

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
  { path: "backend/app.ts", content: 'export const backend = server().post("/orders", ...)' },
  { path: "routes/orders.ts", content: 'export const route = "/orders"' },
  { path: "routes/orders.test.ts", kind: "test", content: 'test("POST /orders", ...)' },
  { path: "server-manifest.ts", kind: "manifest", content: 'routes: ["/orders"]' },
]

async function buildFixture(root: string, contents: string): Promise<void> {
  const out = join(root, "dist")
  await mkdir(out, { recursive: true })
  const source = await fingerprintBuildInputs(root, out)
  await writeFile(join(out, "server.js"), contents)
  expect(await recordBuildProvenance(root, out, source)).toBe(true)
}

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
    expect(result.plan.steps.map((step) => step.kind)).toEqual(["typecheck", "assurance"])
    expect(result.evidence.stop.done).toBe(false)
    expect(result.evidence.stop.next?.command).toBe("nifra prove --run --min 0 --json")

    const initial = createEvidenceBundle(result.graph, result.impact, result.plan)
    const typecheck = result.plan.steps[0]!
    const afterTypecheck = recordProof(initial, {
      id: typecheck.id,
      status: "pass",
      graphDigest: result.graph.digest,
      level: typecheck.level,
      nodeIds: typecheck.nodeIds,
      command: typecheck.command,
    })
    expect(afterTypecheck.stop.next?.id).toBe("proof:assurance")
    const assurance = result.plan.steps[1]!
    const complete = recordProof(afterTypecheck, {
      id: assurance.id,
      status: "pass",
      graphDigest: result.graph.digest,
      level: assurance.level,
      nodeIds: assurance.nodeIds,
      command: assurance.command,
    })
    expect(complete.stop.done).toBe(true)
  })

  test("route mention matching is path-anchored", async () => {
    const paramBackend = server().get(
      "/orders/:id",
      { response: t.object({ ok: t.boolean() }) },
      () => ({ ok: true }),
    )
    const paramFiles: readonly WorkGraphSourceFile[] = [
      { path: "backend/app.ts", content: "export const backend = server()" },
      {
        path: "routes/orders-id.test.ts",
        kind: "test",
        content: 'const response = await app.fetch("/orders/123")',
      },
      {
        path: "routes/unrelated.test.ts",
        kind: "test",
        content: 'test("widget target getUser", () => {})',
      },
    ]
    const result = await buildProjectWorkGraph(
      { source: paramBackend, files: paramFiles, freshness: { ok: true } },
      { changedFiles: [] },
    )
    const edges = result.graph.edges.filter((edge) => edge.relation === "tests")
    expect(edges).toContainEqual({
      from: "test:routes/orders-id.test.ts",
      to: "route:GET /orders/:id",
      relation: "tests",
    })
    expect(edges.some((edge) => edge.from === "test:routes/unrelated.test.ts")).toBe(false)
  })

  test("a higher-level proof never subsumes a lower-level step", async () => {
    const result = await buildProjectWorkGraph(
      { source: backend, files, freshness: { ok: true } },
      { changedFiles: ["routes/orders.ts"], minLevel: 1 },
    )
    const assurance = result.plan.steps.find((step) => step.kind === "assurance")!
    const initial = createEvidenceBundle(result.graph, result.impact, result.plan)
    const afterAssurance = recordProof(initial, {
      id: assurance.id,
      status: "pass",
      graphDigest: result.graph.digest,
      level: assurance.level,
      nodeIds: assurance.nodeIds,
      command: assurance.command,
    })
    expect(afterAssurance.stop.done).toBe(false)
    expect(afterAssurance.stop.next?.id).toBe("proof:typecheck")
    expect(afterAssurance.stop.missing).toContain("nifra prove --run --min 0 --json")
  })

  test("backend changes conservatively impact every reflected route", async () => {
    const result = await buildProjectWorkGraph(
      { source: backend, files, freshness: { ok: true } },
      { changedFiles: ["backend/app.ts"] },
    )
    expect(queryImpact(result.graph, ["backend/app.ts"]).impactedRoutes).toEqual(["POST /orders"])
    expect(queryImpact(result.graph, ["backend/db.ts"]).impactedRoutes).toEqual(["POST /orders"])
    expect(queryImpact(result.graph, ["shared/schema.ts"]).impactedRoutes).toEqual(["POST /orders"])
  })

  test("an impact query reads the edge list once, however many nodes the walk visits", async () => {
    class CountedEdges extends Array<WorkGraphEdge> {
      reads = 0
      override [Symbol.iterator](): ArrayIterator<WorkGraphEdge> {
        this.reads += 1
        return super[Symbol.iterator]()
      }
    }
    const result = await buildProjectWorkGraph(
      { source: backend, files, freshness: { ok: true } },
      { changedFiles: [] },
    )
    const edges = new CountedEdges()
    for (const edge of result.graph.edges) edges.push(edge)
    const impact = queryImpact({ ...result.graph, edges }, ["backend/app.ts"])
    expect(impact.impactedRoutes).toEqual(["POST /orders"])
    expect(impact.impactedNodes.length).toBeGreaterThan(2)
    expect(edges.reads).toBe(1)
  })

  test("an app file the graph does not model still needs proof", async () => {
    const result = await buildProjectWorkGraph(
      { source: backend, files, freshness: { ok: true } },
      { changedFiles: ["routes/removed-page.ts"] },
    )
    expect(result.impact.impactedRoutes).toEqual(["POST /orders"])
    expect(result.impact.impactedNodes).toContain("file:routes/removed-page.ts")
    expect(result.evidence.stop.done).toBe(false)
    // A file outside the app's source directories has nothing to prove.
    expect(queryImpact(result.graph, ["README.md"]).impactedNodes).toEqual([])
  })

  test("proof plans require every rung, even without a changed-file hint", async () => {
    const result = await buildProjectWorkGraph({ source: backend, files }, { minLevel: 4 })
    expect(result.evidence.stop.done).toBe(false)
    expect(result.plan.steps.map((step) => step.kind)).toEqual([
      "typecheck",
      "assurance",
      "capability",
      "manifest",
      "invariants",
    ])
    const step = result.plan.steps[0]!
    expect(() =>
      recordProof(result.evidence, { ...step, graphDigest: "different", status: "pass" }),
    ).toThrow("different snapshot or gate")
    expect(() =>
      recordProof(result.evidence, {
        ...step,
        command: "nifra check --lints-only",
        graphDigest: result.graph.digest,
        status: "pass",
      }),
    ).toThrow("different snapshot or gate")
  })

  test("an executed proof catches TypeScript errors and rejects receipts for a different build", async () => {
    const root = createFixtureProject(fixtures, "run-")
    await mkdir(join(root, "backend"), { recursive: true })
    await mkdir(join(root, "dist"), { recursive: true })
    const app = join(root, "backend/app.ts")
    const artifact = join(root, "dist/server.js")
    const good =
      'import { server } from "@nifrajs/core/server"\nexport const backend = server().get("/", () => "ok")\n'
    await writeFile(join(root, "tsconfig.json"), FIXTURE_TSCONFIG)
    await writeFile(app, good + 'export const value: number = "wrong"\n')
    await utimes(app, new Date(0), new Date(0))
    await buildFixture(root, "export const build = 1")
    const failed = await collectProjectWorkGraph(root, { minLevel: 0, execute: true })
    expect(failed.evidence.stop.done).toBe(false)
    expect(failed.evidence.proofs[0]?.status).toBe("fail")

    await writeFile(app, good)
    await utimes(app, new Date(0), new Date(0))
    await expect(collectProjectWorkGraph(root, { minLevel: 0, execute: true })).rejects.toThrow(
      "source or build contents changed",
    )
    await buildFixture(root, "export const build = 1")
    const passed = await collectProjectWorkGraph(root, { minLevel: 0, execute: true })
    expect(passed.evidence.stop.done).toBe(true)
    expect(passed.evidence.graphDigest).not.toBe(failed.evidence.graphDigest)
    expect(passed.evidence.buildDigest).toBe(failed.evidence.buildDigest)
    const plan = await collectProjectWorkGraph(root, {
      minLevel: 0,
      changedFiles: ["backend/app.ts"],
    })
    const proof = passed.evidence.proofs[0]!
    expect(recordProof(plan.evidence, proof).stop.done).toBe(true)

    await writeFile(artifact, "export const build = 2")
    await expect(collectProjectWorkGraph(root, { minLevel: 0 })).rejects.toThrow(
      "source or build contents changed",
    )
    await buildFixture(root, "export const build = 2")
    const next = await collectProjectWorkGraph(root, { minLevel: 0 })
    expect(next.evidence.stop.done).toBe(false)
    expect(next.evidence.buildDigest).not.toBe(passed.evidence.buildDigest)
    expect(() => recordProof(next.evidence, proof)).toThrow("different snapshot or gate")
  })

  test("freshness checks component, style and public asset bytes", async () => {
    const root = createFixtureProject(fixtures, "inputs-")
    await mkdir(join(root, "routes"), { recursive: true })
    await mkdir(join(root, "public"), { recursive: true })
    await buildFixture(root, "export {}")
    const unchanged = new Date(0)
    for (const file of [
      "routes/index.svelte",
      "routes/about.vue",
      "routes/post.mdx",
      "routes/site.css",
      "public/icon.png",
    ]) {
      const path = join(root, file)
      await writeFile(path, new Uint8Array([0xfe]))
      await utimes(path, unchanged, unchanged)
      expect((await inspectBuildFreshness(root)).reason).toContain(
        "source or build contents changed",
      )
      await buildFixture(root, "export {}")
      expect((await inspectBuildFreshness(root)).ok).toBe(true)
      await writeFile(path, new Uint8Array([0xff]))
      await utimes(path, unchanged, unchanged)
      expect((await inspectBuildFreshness(root)).reason).toContain(
        "source or build contents changed",
      )
      await buildFixture(root, "export {}")
    }
  })

  test("an artifact from an older build is refused without recorded provenance", async () => {
    const root = createFixtureProject(fixtures, "missing-receipt-")
    await mkdir(join(root, "dist"))
    await writeFile(join(root, "dist/server.js"), "export {}")
    expect((await inspectBuildFreshness(root)).reason).toContain("no build provenance")
  })

  test("nifra build records the source and artifact bytes it produced", async () => {
    const root = createFixtureProject(fixtures, "cli-build-")
    writeAppFile(
      root,
      "package.json",
      JSON.stringify({
        name: "build-provenance-fixture",
        type: "module",
        dependencies: { "@nifrajs/core": "workspace:*", "@nifrajs/web-vanilla": "workspace:*" },
      }),
    )
    const backend = writeAppFile(
      root,
      "backend/app.ts",
      'import { server } from "@nifrajs/core/server"\nexport const backend = server().get("/api/test", () => "first")\n',
    )
    const timestamp = new Date(0)
    await utimes(backend, timestamp, timestamp)
    writeAppFile(
      root,
      "nifra.config.ts",
      'export { vanillaAdapter as adapter } from "@nifrajs/web-vanilla"\nexport const clientModule = "./frontend/client.ts"\n',
    )
    writeAppFile(root, "frontend/client.ts", "export function mountRouter() {}\n")
    writeAppFile(root, "routes/index.ts", "export default () => null\n")
    const command = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "build"], {
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    })
    const [code, stderr] = await Promise.all([command.exited, new Response(command.stderr).text()])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect((await inspectBuildFreshness(root)).ok).toBe(true)

    const changed = await open(backend, "w")
    try {
      await changed.writeFile(
        'import { server } from "@nifrajs/core/server"\nexport const backend = server().get("/api/test", () => "second")\n',
      )
      await changed.utimes(timestamp, timestamp)
    } finally {
      await changed.close()
    }
    expect((await inspectBuildFreshness(root)).reason).toContain("source or build contents changed")
  }, 15_000)

  test("a build changed by an invariant run invalidates all of its results", async () => {
    const root = createFixtureProject(fixtures, "changed-build-")
    await mkdir(join(root, "backend"), { recursive: true })
    await mkdir(join(root, "dist"), { recursive: true })
    const app = join(root, "backend/app.ts")
    await writeFile(join(root, "tsconfig.json"), FIXTURE_TSCONFIG)
    await writeFile(
      app,
      'import { server } from "@nifrajs/core/server"\nexport const backend = server().get("/", () => "ok")\n',
    )
    await writeFile(
      join(root, "nifra.assurance.ts"),
      [
        'import { defineAssuranceConfig } from "@nifrajs/core/assurance"',
        'import { backend } from "./backend/app.ts"',
        "export default defineAssuranceConfig({",
        '  source: backend, policy: { rules: [{ name: "all", match: {}, require: [] }] },',
        "  invariants: { async setup() {",
        '    await Bun.write(new URL("./dist/server.js", import.meta.url), "export const changed = 1")',
        "    return { executor: (request: Request) => backend.fetch(request) }",
        "  } },",
        "})",
      ].join("\n"),
    )
    await utimes(app, new Date(0), new Date(0))
    await buildFixture(root, "export {}")
    await expect(collectProjectWorkGraph(root, { execute: true, minLevel: 4 })).rejects.toThrow(
      "source or build changed during verification",
    )
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
