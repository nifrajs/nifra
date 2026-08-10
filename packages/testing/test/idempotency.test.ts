import { describe, expect, test } from "bun:test"
import { proveIdempotency } from "../src/idempotency.ts"

const ledger = (digest: string) => ({
  method: "POST",
  path: "/orders",
  declared: ["db.write"],
  entries: [
    {
      seq: 0,
      at: Date.now(),
      capability: "db.write",
      phase: "committed" as const,
      digest,
    },
  ],
})

describe("proveIdempotency", () => {
  test("ignores wall-clock entry timestamps", async () => {
    const result = await proveIdempotency({ run: () => ledger("a"), runs: 2 })
    expect(result).toEqual({ ok: true, divergences: [] })
  })

  test("reports the first divergent step", async () => {
    let run = 0
    const result = await proveIdempotency({
      run: () => ledger(run++ === 0 ? "a" : "b"),
      runs: 2,
    })
    expect(result.ok).toBe(false)
    expect(result.divergences[0]?.step).toBe(6)
  })
})
