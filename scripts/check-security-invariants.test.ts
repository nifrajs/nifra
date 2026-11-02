import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import {
  readMutationTargets,
  readSecurityInvariantLedger,
  validateSecurityInvariantLedger,
} from "./check-security-invariants.ts"

const root = fileURLToPath(new URL("..", import.meta.url))

describe("security invariant ledger", () => {
  test("every published invariant has executable test and mutation evidence", () => {
    const ledger = readSecurityInvariantLedger(root)
    const targets = readMutationTargets(root)
    expect(ledger.schemaVersion).toBe(1)
    expect(ledger.invariants.length).toBeGreaterThanOrEqual(10)
    expect(validateSecurityInvariantLedger(root, ledger, targets)).toEqual([])
  })

  test("duplicate ids and missing links fail closed", () => {
    const ledger = readSecurityInvariantLedger(root)
    const first = ledger.invariants[0]
    if (first === undefined) throw new Error("fixture ledger is empty")
    const broken = {
      schemaVersion: 1 as const,
      invariants: [
        first,
        { ...first, tests: ["missing/security.test.ts"], mutationTargets: ["missing-target"] },
      ],
    }
    const errors = validateSecurityInvariantLedger(root, broken, {})
    expect(errors.some((error) => error.includes("duplicates"))).toBe(true)
    expect(errors.some((error) => error.includes("missing or outside-repository test path"))).toBe(
      true,
    )
    expect(errors.some((error) => error.includes("missing mutation target"))).toBe(true)
  })

  test("mutation targets require both files and test evidence", () => {
    const ledger = readSecurityInvariantLedger(root)
    const target = ledger.invariants[0]?.mutationTargets[0]
    if (target === undefined) throw new Error("fixture ledger has no mutation target")
    const errors = validateSecurityInvariantLedger(root, ledger, { [target]: { files: ["x.ts"] } })
    expect(errors.some((error) => error.includes(`mutation target ${target} has no tests`))).toBe(
      true,
    )
  })

  test("mutation targets require every listed path to exist", () => {
    const ledger = readSecurityInvariantLedger(root)
    const invariant = ledger.invariants[0]
    const target = invariant?.mutationTargets[0]
    if (invariant === undefined || target === undefined)
      throw new Error("fixture ledger has no mutation target")
    const errors = validateSecurityInvariantLedger(root, ledger, {
      [target]: { files: ["missing-target-file.ts"], tests: ["missing-target-test.ts"] },
    })
    expect(errors).toContain(
      `${invariant.id}: mutation target ${target} has a missing or outside-repository file missing-target-file.ts`,
    )
    expect(errors).toContain(
      `${invariant.id}: mutation target ${target} has a missing or outside-repository test missing-target-test.ts`,
    )
  })
})
