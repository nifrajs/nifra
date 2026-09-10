import { describe, expect, test } from "bun:test"
import { diagnosticCompatibilityOf } from "../src/diagnostics.ts"
import { legacyRules } from "../src/rules/legacy.ts"
import { projectFacts } from "./rule-facts.ts"

const rule = (code: string) => {
  const value = legacyRules.find((candidate) => candidate.code === code)
  if (value === undefined) throw new Error(`rule ${code} not found`)
  return value
}

describe("registry-owned legacy rules", () => {
  test("formats facts directly and keeps the rich fix only in compatibility metadata", async () => {
    const base = projectFacts("src/users.ts", "")
    const facts = {
      ...base,
      sourceFindings: {
        ...base.sourceFindings,
        fetches: [{ file: "src/users.ts", line: 1, snippet: 'fetch("/users")' }],
      },
    }
    const [finding] = await rule("NF-C002").scan({
      root: ".",
      sources: facts.source,
      project: facts,
    })

    expect(finding).toMatchObject({
      code: "NF-C002",
      severity: "error",
      file: "src/users.ts",
      line: 1,
    })
    expect(JSON.stringify(finding)).not.toContain("suggestion")
    expect(diagnosticCompatibilityOf(finding!)).toMatchObject({
      rule: "typed-client",
      fix: expect.stringContaining("client<typeof app>"),
      suggestion: { title: "Replace own-API fetch with the typed nifra client" },
    })
  })

  test("contract notes are structured-only and do not create a legacy finding", async () => {
    const facts = projectFacts("backend.ts", "")
    const [finding] = await rule("NF-K001").scan({
      root: ".",
      sources: facts.source,
      project: facts,
    })

    expect(finding).toMatchObject({ code: "NF-K001", severity: "info" })
    expect(diagnosticCompatibilityOf(finding!)).toBeUndefined()
  })
})
