import { describe, expect, test } from "bun:test"
import {
  readMutationTargets,
  readSecurityInvariantLedger,
  validateSecurityInvariantLedger,
} from "./check-security-invariants.ts"

const root = new URL("..", import.meta.url).pathname

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
    expect(errors.some((error) => error.includes("missing test path"))).toBe(true)
    expect(errors.some((error) => error.includes("missing mutation target"))).toBe(true)
  })
})
