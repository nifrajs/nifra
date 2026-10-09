import { afterAll, describe, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import { snapshotContracts } from "../src/contracts.ts"
import {
  createFixtureProject,
  createFixtureRoot,
  removeFixtureRoot,
  writeAppFile,
} from "./fixture-root.ts"

// The contract-lock check imports the backend, so fixtures live in the workspace where it resolves.
const FIXTURES = createFixtureRoot("tmp-input-before-auth-")
afterAll(() => removeFixtureRoot(FIXTURES))

const IMPORTS = [
  'import { authenticated, server } from "@nifrajs/core"',
  'import { assure, NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"',
  'import { bearer } from "@nifrajs/middleware"',
  'import { t } from "@nifrajs/schema"',
  "const body = t.object({ name: t.string() })",
  "// A hand-written guard that claims runtime auth evidence but checks in a hook.",
  "const hookAuth = withRouteAssurance(",
  "  (app: ReturnType<typeof server>) => app.beforeHandle(() => undefined),",
  '  { id: NIFRA_ASSURANCE.AUTHENTICATED, source: "custom-auth", scope: "subsequent" },',
  ")",
  "",
].join("\n")

async function findings(backend: string, lock = true) {
  const root = createFixtureProject(FIXTURES, "app-")
  writeAppFile(root, "backend/app.ts", `${IMPORTS}${backend}\n`)
  if (lock) await snapshotContracts(root)
  return (await collectCheckResult(root, { lintsOnly: true })).structuredDiagnostics
    ?.filter((d) => d.code === "NF-S008")
    .map((d) => ({ file: d.file, severity: d.severity, evidence: d.evidence, message: d.message }))
}

describe("NF-S008", () => {
  test("a hook-authenticated route with declared input is named; routes without input are not", async () => {
    const found = await findings(
      [
        "export const backend = server()",
        "  .use(hookAuth)",
        '  .post("/orders", { body }, () => 1)',
        '  .get("/search", { query: t.object({ q: t.string() }) }, () => 1)',
        '  .get("/plain", () => 1)',
      ].join("\n"),
    )
    expect(found?.map((f) => f.evidence)).toEqual([["POST /orders"], ["GET /search"]])
    expect(found?.[0]?.file).toBe("backend/app.ts")
    expect(found?.[0]?.severity).toBe("warn")
    expect(found?.[0]?.message).toContain("app.authenticate()")
    expect(found?.[0]?.message).toContain('validationOrder: "auth-before-validation"')
  })

  test("an explicit validationOrder is the author's choice in either direction", async () => {
    const found = await findings(
      [
        "export const backend = server()",
        "  .use(hookAuth)",
        '  .post("/first", { body, validationOrder: "auth-before-validation" }, () => 1)',
        '  .post("/after", { body, validationOrder: "validate-before-auth" }, () => 1)',
      ].join("\n"),
    )
    expect(found).toEqual([])
  })

  test("authenticate(), first-party middleware and gateway auth are clean", async () => {
    const backends = [
      [
        "export const backend = server()",
        "  .use(hookAuth)",
        '  .authenticate({ id: "session", run: () => authenticated({ id: "u1" }) })',
        '  .post("/core", { body }, () => 1)',
      ],
      [
        "export const backend = server()",
        "  .use(hookAuth)",
        "  .use(bearer({ verify: () => null }))",
        '  .post("/bearer", { body }, () => 1)',
      ],
      [
        'export const backend = server().post("/gateway", { body }, () => 1)',
        'assure(backend, { id: NIFRA_ASSURANCE.AUTHENTICATED, source: "edge-gateway" })',
      ],
    ]
    for (const lines of backends) expect(await findings(lines.join("\n"))).toEqual([])
  })

  test("with no contracts lock the check loads no backend, so the rule has nothing to read", async () => {
    const found = await findings(
      'export const backend = server().use(hookAuth).post("/orders", { body }, () => 1)',
      false,
    )
    expect(found).toEqual([])
  })
})
