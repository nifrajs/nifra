import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { collectVerificationLevels, runLevels } from "../src/levels-tool.ts"
import { runManifestEmit } from "../src/manifest-tool.ts"
import { createFixtureProject, createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"

const FIXTURES = createFixtureRoot("nifra-levels-fixtures-")

afterAll(async () => {
  removeFixtureRoot(FIXTURES)
})

/** A minimal project whose ladder climbs as far as the pieces we write for it. */
async function project(
  name: string,
  options: { assurance?: boolean; shellEvidence?: boolean } = {},
): Promise<string> {
  const cwd = createFixtureProject(FIXTURES, `${name}-`)
  await mkdir(join(cwd, "backend"), { recursive: true })
  await writeFile(
    join(cwd, "backend/app.ts"),
    [
      `import { server } from "@nifrajs/core"`,
      ...(options.shellEvidence === true
        ? [`import { assure, NIFRA_ASSURANCE } from "@nifrajs/core/assurance"`]
        : []),
      `const okBody = {`,
      `  "~standard": { version: 1, vendor: "levels-test", validate: (value) => (typeof value?.amount === "number" ? { value } : { issues: [{ message: "amount" }] }) },`,
      `  jsonSchema: { type: "object", properties: { amount: { type: "number", minimum: 1, maximum: 9 } }, required: ["amount"] },`,
      `}`,
      `export const backend = server().post("/pay", { body: okBody }, () => ({ ok: true }))`,
      // A route with an options object that reflects to NO schema parts. The two manifest input
      // paths canonicalize this differently (evidence keeps an empty `schema: {}`, a source
      // reflection omits the key), which is exactly what made the recomputed hash diverge.
      ...(options.shellEvidence === true ? [`backend.get("/ping", {}, () => ({ ok: true }))`] : []),
      // Evidence published from OUTSIDE the `.use()` chain - the deployment-shell case `assure()`
      // exists for, and the one where the manifest built from `source` alone stops matching.
      ...(options.shellEvidence === true
        ? [`assure(backend, { id: NIFRA_ASSURANCE.SECURITY_HEADERS, source: "levels-test-shell" })`]
        : []),
      "",
    ].join("\n"),
  )
  if (options.assurance !== false) {
    await writeFile(
      join(cwd, "nifra.assurance.ts"),
      [
        `import { defineAssuranceConfig } from "@nifrajs/core/assurance"`,
        `import { backend } from "./backend/app.ts"`,
        `export default defineAssuranceConfig({`,
        `  source: backend,`,
        `  policy: { rules: [{ name: "all", match: {}, require: [] }] },`,
        `  invariants: { executor: (request) => backend.fetch(request) },`,
        `})`,
        "",
      ].join("\n"),
    )
  }
  return cwd
}

describe("nifra levels", () => {
  test("without an assurance config the ladder stops at L0, with the reason on every rung", async () => {
    const cwd = await project("no-config", { assurance: false })
    const result = await collectVerificationLevels(cwd)
    expect(result.levels[0]?.ok).toBe(true) // typed contract holds
    expect(result.achieved).toBe(0)
    for (const status of result.levels.slice(1)) {
      expect(status.ok).toBe(false)
      expect(status.reasons.length).toBeGreaterThan(0)
    }
  })

  test("climbs to L1 with assurance, and reports why L2/L3 are missing", async () => {
    const cwd = await project("l1")
    const result = await collectVerificationLevels(cwd)
    expect(result.levels[1]?.ok).toBe(true)
    expect(result.achieved).toBe(1)
    expect(result.levels[2]?.reasons[0]).toMatch(/no capabilities policy/)
    expect(result.levels[3]?.reasons[0]).toMatch(/manifest missing/)
  })

  test("the ladder is cumulative: a passing L3 does not count while L2 fails", async () => {
    const cwd = await project("gap")
    expect(await runManifestEmit(cwd)).toBe(true) // L3 artifact present + in sync
    const result = await collectVerificationLevels(cwd)
    expect(result.levels[3]?.ok).toBe(true) // rung itself holds…
    expect(result.levels[2]?.ok).toBe(false) // …but the rung below it does not
    expect(result.achieved).toBe(1) // so the achieved level stays below the gap
  })

  test("a freshly emitted manifest is not stale when the app carries shell-published evidence", async () => {
    // Regression: L3 recomputed the manifest from `source` alone while `manifest emit` (and the
    // `versioned trust manifest drift` rule in `nifra check`) hash it WITH the project evidence
    // snapshot. Any app using `assure()` from outside its plugin chain therefore emitted a manifest
    // that `nifra levels` immediately called stale, capping it at L2 with nothing to fix.
    const cwd = await project("shell-evidence", { shellEvidence: true })
    expect(await runManifestEmit(cwd)).toBe(true)
    const result = await collectVerificationLevels(cwd)
    expect(result.levels[3]?.reasons).toEqual([])
    expect(result.levels[3]?.ok).toBe(true)
  })

  test("L4 runs contract invariants only through the configured isolated executor", async () => {
    const cwd = await project("l4")
    const result = await collectVerificationLevels(cwd)
    expect(result.levels[4]?.ok).toBe(true) // the fixture app satisfies its own contract
  })

  test("runLevels honors --min for CI gating and --json emits the structured report", async () => {
    const cwd = await project("gate")
    expect(await runLevels(cwd, { min: 1, json: true })).toBe(true)
    expect(await runLevels(cwd, { min: 3 })).toBe(false)
  })
})

/** A project whose L4 needs fixture help: an opaque body schema and a session-guarded surface. */
async function invariantProject(
  name: string,
  invariants: string,
  options: { guarded?: boolean; opaque?: boolean } = {},
): Promise<string> {
  const cwd = createFixtureProject(FIXTURES, `${name}-`)
  await mkdir(join(cwd, "backend"), { recursive: true })
  await writeFile(
    join(cwd, "backend/app.ts"),
    [
      `import { server } from "@nifrajs/core"`,
      `const body = {`,
      `  "~standard": { version: 1, vendor: "levels-test", validate: (value) => (typeof value?.amount === "number" ? { value } : { issues: [{ message: "amount" }] }) },`,
      ...(options.opaque === true
        ? []
        : [
            `  jsonSchema: { type: "object", properties: { amount: { type: "number", minimum: 1, maximum: 9 } }, required: ["amount"] },`,
          ]),
      `}`,
      `export const backend = server()`,
      ...(options.guarded === true
        ? [
            `  .onRequest((req) => (req.headers.get("x-session") === "fixture" ? undefined : new Response("no session", { status: 401 })))`,
          ]
        : []),
      `  .post("/pay", { body }, () => ({ ok: true }))`,
      "",
    ].join("\n"),
  )
  await writeFile(
    join(cwd, "nifra.assurance.ts"),
    [
      `import { defineAssuranceConfig } from "@nifrajs/core/assurance"`,
      `import { backend } from "./backend/app.ts"`,
      `const calls = ((globalThis as Record<string, unknown>).__levelsCalls ??= {}) as Record<string, string[]>`,
      `const log = (calls[${JSON.stringify(name)}] ??= [])`,
      `export default defineAssuranceConfig({`,
      `  source: backend,`,
      `  policy: { rules: [{ name: "all", match: {}, require: [] }] },`,
      `  invariants: ${invariants},`,
      `})`,
      "",
    ].join("\n"),
  )
  return cwd
}

const callsOf = (name: string): string[] => {
  const calls: unknown = Reflect.get(globalThis, "__levelsCalls")
  const list: unknown = typeof calls === "object" && calls !== null ? Reflect.get(calls, name) : []
  return Array.isArray(list)
    ? list.filter((entry): entry is string => typeof entry === "string")
    : []
}

describe("nifra levels L4 fixture options", () => {
  test("witnesses reach the runner, so an opaque schema can be covered", async () => {
    const without = await invariantProject(
      "no-witness",
      `{ executor: (request) => backend.fetch(request) }`,
      { opaque: true },
    )
    expect((await collectVerificationLevels(without)).levels[4]?.reasons.join("\n")).toMatch(
      /opaque body schema needs witnesses/,
    )
    const cwd = await invariantProject(
      "witness",
      `{ executor: (request) => backend.fetch(request), witnesses: { "POST /pay": { body: { amount: 3 } } } }`,
      { opaque: true },
    )
    expect((await collectVerificationLevels(cwd)).levels[4]).toMatchObject({
      ok: true,
      reasons: [],
    })
  })

  test("prepareRequest reaches the runner, so a session-guarded app can be exercised", async () => {
    const without = await invariantProject(
      "no-prepare",
      `{ executor: (request) => backend.fetch(request) }`,
      { guarded: true },
    )
    expect((await collectVerificationLevels(without)).levels[4]?.ok).toBe(false)
    const cwd = await invariantProject(
      "prepare",
      `{
    executor: (request) => backend.fetch(request),
    prepareRequest: (request, context) => {
      log.push(context.caseId === "" ? "empty" : "case")
      const headers = new Headers(request.headers)
      headers.set("x-session", "fixture")
      return new Request(request, { headers })
    },
  }`,
      { guarded: true },
    )
    expect((await collectVerificationLevels(cwd)).levels[4]).toMatchObject({
      ok: true,
      reasons: [],
    })
    expect(callsOf("prepare").length).toBeGreaterThan(0)
  })

  test("isRejected and include reach the runner", async () => {
    const cwd = await invariantProject(
      "reject-hook",
      `{
    executor: (request) => backend.fetch(request),
    include: (route) => { log.push(\`include \${route.method} \${route.path}\`); return true },
    isRejected: (response) => { log.push("judged"); return response.status === 401 },
  }`,
      { guarded: true },
    )
    const result = await collectVerificationLevels(cwd)
    expect(callsOf("reject-hook")).toContain("include POST /pay")
    expect(callsOf("reject-hook")).toContain("judged")
    expect(result.levels[4]?.reasons.join("\n")).not.toMatch(/was not rejected/)
  })

  test("setup runs once, lazily, and its executor and teardown are used", async () => {
    const cwd = await invariantProject(
      "setup",
      `{
    setup: async () => {
      log.push("setup")
      return { executor: (request) => backend.fetch(request), teardown: async () => void log.push("teardown") }
    },
  }`,
    )
    await import(join(cwd, "nifra.assurance.ts"))
    expect(callsOf("setup")).toEqual([]) // importing the config provisions nothing
    const result = await collectVerificationLevels(cwd)
    expect(result.levels[4]).toMatchObject({ ok: true, reasons: [] })
    expect(callsOf("setup")).toEqual(["setup", "teardown"])
  })

  test("teardown still runs when L4 fails", async () => {
    const cwd = await invariantProject(
      "setup-fails-run",
      `{
    setup: async () => {
      log.push("setup")
      return { executor: () => Response.json({ ok: true }), teardown: () => void log.push("teardown") }
    },
  }`,
    )
    const result = await collectVerificationLevels(cwd)
    expect(result.levels[4]?.ok).toBe(false)
    expect(callsOf("setup-fails-run")).toEqual(["setup", "teardown"])
  })

  test("a setup that throws is one reason, and a teardown that throws is reported", async () => {
    const broken = await invariantProject(
      "setup-throws",
      `{ setup: async () => { throw new Error("no target available") } }`,
    )
    const reasons = (await collectVerificationLevels(broken)).levels[4]?.reasons ?? []
    expect(reasons).toEqual(["invariants.setup failed: no target available"])

    const leaky = await invariantProject(
      "teardown-throws",
      `{
    setup: async () => ({
      executor: (request) => backend.fetch(request),
      teardown: async () => { throw new Error("container still running") },
    }),
  }`,
    )
    expect((await collectVerificationLevels(leaky)).levels[4]?.reasons).toEqual([
      "invariants teardown failed: container still running",
    ])
  })

  test("a setup that returns no executor, with none configured, says so", async () => {
    const cwd = await invariantProject("setup-no-executor", `{ setup: async () => {} }`)
    expect((await collectVerificationLevels(cwd)).levels[4]?.reasons).toEqual([
      "no invariant executor: invariants.setup returned none and invariants.executor is not set",
    ])
  })
})
