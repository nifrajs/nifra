import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { server } from "@nifrajs/core"
import { defineCapabilityPolicy } from "@nifrajs/core/capabilities"
import {
  collectCapabilityProjectReport,
  diffCapabilitySnapshots,
  parseCapabilityLockfile,
  runCapabilityCheck,
  runCapabilitySnapshot,
  scanEffectImports,
} from "../src/capabilities-tool.ts"
import { collectCheckResult } from "../src/check.ts"

const FIXTURES = join(import.meta.dir, ".tmp-nifra-capability-fixtures")

afterAll(async () => {
  await rm(FIXTURES, { recursive: true, force: true })
})

const policy = defineCapabilityPolicy({
  definitions: [
    { id: "db.read", zone: "domain", access: "read" },
    { id: "db.write", zone: "domain", access: "write", idempotency: "request" },
  ],
  provenance: {
    imports: [
      { specifier: "app-db/read", capabilities: ["db.read"] },
      { specifier: "app-db/write", capabilities: ["db.write"] },
    ],
    forbiddenImports: [{ specifier: "postgres", reason: "use the tenant-scoped app-db adapter" }],
  },
})

describe("effect import scanner", () => {
  test("sees static, dynamic, require, and re-export imports but skips type-only imports", () => {
    expect(
      scanEffectImports(`
        import value from "app-db/read"
        import type { Row } from "app-db/types"
        const raw = await import("postgres")
        const x = require("app-db/write")
        export { helper } from "./helper"
        const templated = await import(\`app-db/read\`)
        // import(\`commented\`)
      `),
    ).toEqual(["app-db/read", "postgres", "app-db/write", "./helper", "app-db/read"])
  })
})

describe("project provenance firewall", () => {
  test("walks local imports, attributes effects conservatively, and reports raw bypasses", async () => {
    const cwd = join(FIXTURES, "raw-bypass")
    await mkdir(join(cwd, "src"), { recursive: true })
    await writeFile(
      join(cwd, "backend.ts"),
      `import { server } from "@nifrajs/core"
       import { mutate } from "./src/orders.ts"
       export const backend = server().post("/orders", { capabilities: ["db.write"] }, mutate)`,
    )
    await writeFile(
      join(cwd, "src/orders.ts"),
      `import db from "postgres"
       import { write } from "app-db/write"
       export const mutate = () => ({ ok: Boolean(db && write) })`,
    )
    const app = server().post("/orders", { capabilities: ["db.write"] }, () => ({ ok: true }))
    const project = await collectCapabilityProjectReport(cwd, app, policy)

    expect(project.report.routes[0]).toMatchObject({ covered: true })
    expect(project.report.routes[0]?.evidence.map((item) => item.id)).toEqual(["db.write"])
    expect(project.violations).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/orders",
        specifier: "postgres",
        chain: ["backend.ts", "./src/orders.ts", "postgres"],
      }),
    ])
  })

  test("explicit routeModules cover contract-style registrations", async () => {
    const cwd = join(FIXTURES, "explicit")
    await mkdir(join(cwd, "src"), { recursive: true })
    await writeFile(join(cwd, "src/list.ts"), 'import "app-db/read"\n')
    const app = server().get("/orders", { capabilities: ["db.read"] }, () => [])
    const explicit = defineCapabilityPolicy({
      ...policy,
      provenance: {
        ...policy.provenance,
        routeModules: [
          { match: { methods: ["GET"], paths: ["/orders"] }, modules: ["src/list.ts"] },
        ],
      },
    })
    const project = await collectCapabilityProjectReport(cwd, app, explicit)
    expect(project.report).toMatchObject({ ok: true, findings: [] })
  })

  test("treats an explicitly approved effect adapter as the provider trust boundary", async () => {
    const cwd = join(FIXTURES, "approved-boundary")
    await mkdir(cwd, { recursive: true })
    await writeFile(
      join(cwd, "backend.ts"),
      `import "./write-adapter.ts"
       import { server } from "@nifrajs/core"
       export const backend = server().get("/orders", { capabilities: ["db.read"] }, () => [])`,
    )
    await writeFile(join(cwd, "write-adapter.ts"), `import "postgres"\n`)
    const app = server().get("/orders", { capabilities: ["db.read"] }, () => ({ ok: true }))
    const approved = defineCapabilityPolicy({
      ...policy,
      provenance: {
        ...policy.provenance,
        imports: [{ specifier: "./write-adapter.ts", capabilities: ["db.read"] }],
      },
    })

    const project = await collectCapabilityProjectReport(cwd, app, approved)
    expect(project.report).toMatchObject({ ok: true, findings: [] })
    expect(project.violations).toEqual([])
  })
})

describe("capability lockfile", () => {
  const baseline = {
    nifraCapabilities: 1 as const,
    routes: [
      { method: "GET", path: "/x", declared: ["db.read"], evidenced: ["db.read"], unproven: [] },
    ],
  }

  test("validates the versioned envelope and reports exact deterministic drift", () => {
    expect(parseCapabilityLockfile(JSON.stringify(baseline), "lock.json")).toEqual(baseline)
    expect(() => parseCapabilityLockfile("{}", "lock.json")).toThrow(
      "not a nifra capability lockfile",
    )
    expect(
      diffCapabilitySnapshots(baseline, {
        nifraCapabilities: 1,
        routes: [
          {
            method: "GET",
            path: "/x",
            declared: ["db.read", "db.write"],
            evidenced: ["db.read", "db.write"],
            unproven: [],
          },
        ],
      }),
    ).toEqual(["GET /x: declared added db.write", "GET /x: evidenced added db.write"])
  })

  test("snapshot/check form a fail-closed end-to-end CI gate", async () => {
    const cwd = join(FIXTURES, "lock-gate")
    await mkdir(cwd, { recursive: true })
    await writeFile(
      join(cwd, "backend.ts"),
      `import { server } from "@nifrajs/core"
       import "./repo.ts"
       export const backend = server().get("/orders", { capabilities: ["db.read"] }, () => [])`,
    )
    await writeFile(join(cwd, "repo.ts"), `export const repository = true\n`)
    await writeFile(
      join(cwd, "nifra.assurance.ts"),
      `import { defineAssuranceConfig } from "@nifrajs/core/assurance"
       import { backend } from "./backend.ts"
       export default defineAssuranceConfig({
         source: backend,
         policy: { rules: [{ name: "all", match: {}, require: [] }] },
         capabilities: {
           definitions: [{ id: "db.read", zone: "domain", access: "read" }],
           provenance: {
             imports: [{ specifier: "./repo.ts", capabilities: ["db.read"] }],
             forbiddenImports: [{ specifier: "postgres", reason: "raw database bypass" }],
           },
         },
       })`,
    )
    expect(await runCapabilitySnapshot(cwd)).toBe(true)
    expect(await runCapabilityCheck(cwd)).toBe(true)

    const lockPath = join(cwd, "capabilities.lock.json")
    const lock = parseCapabilityLockfile(await Bun.file(lockPath).text(), lockPath)
    await writeFile(
      lockPath,
      JSON.stringify({
        ...lock,
        routes: lock.routes.map((route) => ({ ...route, declared: [] })),
      }),
    )
    expect(await runCapabilityCheck(cwd)).toBe(false)
  })

  test("nifra check includes the forbidden-import provenance firewall", async () => {
    const cwd = join(FIXTURES, "check-firewall")
    await mkdir(cwd, { recursive: true })
    await writeFile(
      join(cwd, "backend.ts"),
      `import { server } from "@nifrajs/core"
       import "./read-adapter.ts"
       import "./repo.ts"
       export const backend = server().get("/orders", { capabilities: ["db.read"] }, () => [])`,
    )
    await writeFile(join(cwd, "read-adapter.ts"), `export const readAdapter = true\n`)
    await writeFile(join(cwd, "repo.ts"), `import "node:fs"\n`)
    await writeFile(
      join(cwd, "nifra.assurance.ts"),
      `import { defineAssuranceConfig } from "@nifrajs/core/assurance"
       import { backend } from "./backend.ts"
       export default defineAssuranceConfig({
         source: backend,
         policy: { rules: [{ name: "all", match: {}, require: [] }] },
         capabilities: {
           definitions: [{ id: "db.read", zone: "domain", access: "read" }],
           provenance: {
             imports: [{ specifier: "./read-adapter.ts", capabilities: ["db.read"] }],
             forbiddenImports: [{ specifier: "node:fs", reason: "raw effect bypass" }],
           },
         },
       })`,
    )
    const result = await collectCheckResult(cwd, { lintsOnly: true })
    expect(result.diagnostics.map((item) => `${item.rule}: ${item.message}`)).toContainEqual(
      expect.stringContaining("raw effect bypass"),
    )
    const diagnostic = result.diagnostics.find((item) => item.rule === "capability-assurance")
    expect(diagnostic?.chain).toEqual(["backend.ts", "./repo.ts", "node:fs"])
    expect(diagnostic?.message).toContain("raw effect bypass")
    expect(result.ok).toBe(false)
  })
})
