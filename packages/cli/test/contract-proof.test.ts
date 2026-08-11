import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { collectContractProof } from "../src/contract-proof.ts"

const FIXTURES = join(import.meta.dir, ".tmp-nifra-contract-proof")

afterAll(async () => {
  await rm(FIXTURES, { recursive: true, force: true })
})

describe("joined contract proof", () => {
  test("joins route changes to assurance and capability evidence without forcing check", async () => {
    const cwd = join(FIXTURES, "joined")
    await mkdir(cwd, { recursive: true })
    await writeFile(
      join(cwd, "backend.ts"),
      [
        'import { server } from "@nifrajs/core"',
        'import "./read-adapter.ts"',
        'export const backend = server().get("/orders", { capabilities: ["db.read"], assurance: ["nifra.authenticated"] }, () => ({ ok: true }))',
        "",
      ].join("\n"),
    )
    await writeFile(join(cwd, "read-adapter.ts"), "export const read = true\n")
    await writeFile(
      join(cwd, "nifra.assurance.ts"),
      [
        'import { defineAssuranceConfig } from "@nifrajs/core/assurance"',
        'import { defineCapabilityPolicy } from "@nifrajs/core/capabilities"',
        'import { backend } from "./backend.ts"',
        "export default defineAssuranceConfig({",
        "  source: backend,",
        '  policy: { rules: [{ name: "authenticated", match: {}, require: ["nifra.authenticated"] }] },',
        "  capabilities: defineCapabilityPolicy({",
        '    definitions: [{ id: "db.read", zone: "domain", access: "read" }],',
        '    provenance: { imports: [{ specifier: "./read-adapter.ts", capabilities: ["db.read"] }], forbiddenImports: [] },',
        "  }),",
        "})",
        "",
      ].join("\n"),
    )
    await writeFile(
      join(cwd, "api-snapshot.json"),
      JSON.stringify({ nifraSnapshot: 1, routes: [] }),
    )

    const report = await collectContractProof(cwd)
    expect(report.hasBreaking).toBe(false)
    expect(report.verification).not.toHaveProperty("check")
    expect(report.verification.assurance).toMatchObject({ ok: true, routeCount: 1 })
    expect(report.verification.capability).toMatchObject({ ok: true, routeCount: 1 })
    expect(report.routes).toHaveLength(1)
    expect(report.routes[0]).toMatchObject({
      method: "GET",
      path: "/orders",
      assurance: {
        route: { rule: "authenticated", evidence: [{ id: "nifra.authenticated" }] },
      },
      capability: {
        route: {
          declared: ["db.read"],
          evidence: [{ id: "db.read", source: "./read-adapter.ts" }],
        },
      },
    })
  })

  test("rejects a baseline outside the project directory", async () => {
    const cwd = join(FIXTURES, "safe-path")
    await mkdir(cwd, { recursive: true })
    await expect(
      collectContractProof(cwd, { baselinePath: "../../outside/api-snapshot.json" }),
    ).rejects.toThrow("must stay inside")
  })
})
