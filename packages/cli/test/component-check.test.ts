import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveServerOnlyChains } from "../src/check-scan.ts"
import { componentCheckReceipts } from "../src/component-check.ts"
import { sourceIndex } from "../src/rules/index.ts"
import { legacyRules } from "../src/rules/legacy.ts"
import { zoneImportRule } from "../src/rules/zones.ts"
import { projectFacts } from "./rule-facts.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(enabled: boolean, forged = false) {
  const root = mkdtempSync(join(tmpdir(), "nifra-component-check-"))
  roots.push(root)
  mkdirSync(join(root, "backend"))
  for (const file of ["entry.client.ts", "entry.backend.ts"])
    writeFileSync(join(root, file), "export {}")
  writeFileSync(
    join(root, "nifra.config.ts"),
    'throw new Error("check must never execute configuration");\n' +
      (enabled
        ? 'export const componentPipeline = { adapter: "vue", entries: { client: "entry.client.ts", ssr: "entry.backend.ts" } }'
        : "export const target = 'bun'"),
  )
  const file = "backend/Summary.component.server.ts"
  const content = forged
    ? 'export const Summary = { reference: "forged" }'
    : 'import { defineServerComponent as define } from "@nifrajs/web/server-components"; export const Summary = define({ input: {}, props: {}, load() {}, authorize() {}, view() {} })'
  writeFileSync(join(root, file), content)
  const source = sourceIndex([{ file, content }])
  return { root, file, source }
}
test("check accepts only exact compiler receipts in an explicitly configured component lane", async () => {
  for (const enabled of [false, true])
    for (const forged of [false, true]) {
      const f = fixture(enabled, forged)
      const { receipts } = await componentCheckReceipts(f.root, f.source)
      const findings = resolveServerOnlyChains(
        "frontend/Page.frontend.ts",
        'import { Summary } from "../backend/Summary.component.server"',
        () => f.file,
        () => f.source.read(f.file),
        undefined,
        receipts,
      )
      expect(findings.length).toBe(enabled && !forged ? 0 : 1)
    }
})
test("a valid component receipt cannot authorize a neighboring ordinary backend module", async () => {
  const f = fixture(true)
  const findings = resolveServerOnlyChains(
    "frontend/Page.frontend.ts",
    'import { secret } from "../backend/secret.backend"',
    () => "backend/secret.backend.ts",
    () => "export const secret = 'fixture'",
    undefined,
    (await componentCheckReceipts(f.root, f.source)).receipts,
  )
  expect(findings[0]?.chain).toEqual(["frontend/Page.frontend.ts", "../backend/secret.backend"])
})

test("NF-C028 permits only exact component handles from the configured compiler", async () => {
  for (const enabled of [false, true])
    for (const forged of [false, true]) {
      const f = fixture(enabled, forged)
      mkdirSync(join(f.root, "shared"))
      const file = "shared/Handle.shared.ts"
      const content =
        'import { Summary } from "../backend/Summary.component.server"; export { Summary }'
      writeFileSync(join(f.root, file), content)
      const source = sourceIndex([
        { file, content },
        { file: f.file, content: f.source.read(f.file)! },
      ])
      const findings = await zoneImportRule.scan({
        root: f.root,
        sources: source,
        project: projectFacts(file, content),
      })
      expect(findings.length).toBe(enabled && !forged ? 0 : 1)
    }
})

test("a TypeScript with no compiler API leaves component modules to the import rule, and says why", async () => {
  const f = fixture(true)
  const message =
    "NIFRA_TS_UNSUPPORTED: server components read component modules with the TypeScript compiler API"
  const unsupported = Object.assign(new Error(message), {
    code: "NIFRA_TS_UNSUPPORTED",
    version: "7.0.2",
  })
  const check = await componentCheckReceipts(f.root, f.source, () => Promise.reject(unsupported))
  expect(check.receipts.size).toBe(0)
  expect(check.unsupported?.version).toBe("7.0.2")
  await expect(
    componentCheckReceipts(f.root, f.source, () => Promise.reject(new Error("other"))),
  ).rejects.toThrow("other")

  const facts = projectFacts(f.file, f.source.read(f.file)!)
  const rule = legacyRules.find((candidate) => candidate.code === "NF-C004")!
  const findings = await rule.scan({
    root: f.root,
    sources: f.source,
    project: {
      ...facts,
      check: { ...facts.check, componentCheckUnsupported: { version: "7.0.2", message } },
    },
  })
  expect(findings.map((finding) => [finding.code, finding.message])).toEqual([
    ["NIFRA_TS_UNSUPPORTED", message],
  ])
})
