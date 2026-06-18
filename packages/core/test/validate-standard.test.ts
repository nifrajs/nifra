import { describe, expect, test } from "bun:test"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"
import { validateStandard } from "../src/schema/standard.ts"

/**
 * `validateStandard` was changed from always-`async` to **sync-or-async**: a synchronous Standard
 * Schema validator now returns the outcome WITHOUT a Promise (so the lifecycle's query/body validation
 * doesn't allocate a promise for the common sync schema), while an async validator is still awaited.
 * `await validateStandard(...)` works for both — but callers that branch on `instanceof Promise` (the
 * server does) depend on the sync path actually staying sync. These tests pin that contract + that
 * both paths still validate + reject correctly.
 */
function schema<Output>(
  validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>,
): StandardSchemaV1<unknown, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "nifra-test",
      validate,
      types: undefined as unknown as StandardTypes<unknown, Output>,
    },
  }
}

const syncOk = schema<{ n: number }>(() => ({ value: { n: 1 } }))
const syncFail = schema<{ n: number }>(() => ({ issues: [{ message: "bad", path: ["n"] }] }))
const asyncOk = schema<{ n: number }>(async () => ({ value: { n: 2 } }))
const asyncFail = schema<{ n: number }>(async () => ({ issues: [{ message: "bad async" }] }))

describe("validateStandard — sync stays sync, async is awaited", () => {
  test("a sync validator returns a NON-Promise success outcome (the perf invariant)", () => {
    const out = validateStandard(syncOk, {})
    expect(out instanceof Promise).toBe(false)
    expect(out).toEqual({ ok: true, value: { n: 1 } })
  })

  test("a sync validator's failure is also returned synchronously", () => {
    const out = validateStandard(syncFail, {})
    expect(out instanceof Promise).toBe(false)
    expect(out).toEqual({ ok: false, issues: [{ message: "bad", path: ["n"] }] })
  })

  test("an async validator returns a Promise resolving to the success outcome", async () => {
    const out = validateStandard(asyncOk, {})
    expect(out instanceof Promise).toBe(true)
    expect(await out).toEqual({ ok: true, value: { n: 2 } })
  })

  test("an async validator's failure resolves to the issues outcome", async () => {
    const out = validateStandard(asyncFail, {})
    expect(out instanceof Promise).toBe(true)
    expect(await out).toEqual({ ok: false, issues: [{ message: "bad async" }] })
  })

  test("`await` works uniformly regardless of sync/async (the caller contract)", async () => {
    expect(await validateStandard(syncOk, {})).toEqual({ ok: true, value: { n: 1 } })
    expect(await validateStandard(asyncOk, {})).toEqual({ ok: true, value: { n: 2 } })
  })
})
