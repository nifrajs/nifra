import { describe, expect, test } from "bun:test"
import { t } from "../src/index.ts"

/**
 * `t` must validate on edge runtimes (Cloudflare Workers, Vercel Edge, Deno Deploy) that forbid
 * dynamic code generation. Its fast path compiles a validator with `new Function`; when codegen is
 * unavailable the adapter falls back to TypeBox's eval-free `Value` checker.
 *
 * We simulate the restriction by replacing the global `Function` constructor so `new Function`
 * throws — exactly what those runtimes do. Under the stub the compiled path is *impossible*, so a
 * validate that still returns the right answer can only have used the eval-free fallback. (On the
 * old code `TypeCompiler.Compile` threw uncaught here — this is the regression guard.)
 *
 * All `expect()` calls run AFTER the real `Function` is restored, so the test runner's own
 * machinery never executes under the stub.
 */
function whileCodegenBlocked<R>(fn: () => R): { blocked: boolean; result: R } {
  const RealFunction = globalThis.Function
  let blocked = false
  // Swap the global constructor that `new Function(src)` invokes. `as unknown as` is unavoidable:
  // a stub that only throws on `new` isn't structurally a FunctionConstructor.
  const stub = (): never => {
    throw new EvalError("Code generation from strings disallowed for this context")
  }
  globalThis.Function = stub as unknown as typeof globalThis.Function
  try {
    try {
      // Confirms the stub is effective: if this throws, the compiled path is genuinely blocked.
      new Function("return 1")
    } catch {
      blocked = true
    }
    return { blocked, result: fn() }
  } finally {
    globalThis.Function = RealFunction
  }
}

function isIssues(
  r: unknown,
): r is { issues: ReadonlyArray<{ path?: ReadonlyArray<PropertyKey> }> } {
  return typeof r === "object" && r !== null && "issues" in r
}

describe("edge runtime — no dynamic codegen", () => {
  test("validates a valid value without new Function (eval-free fallback)", () => {
    const { blocked, result } = whileCodegenBlocked(() => {
      // Fresh, uncompiled schema created inside the blocked window.
      const schema = t.object({ name: t.string({ minLength: 1 }), age: t.integer() })
      return schema["~standard"].validate({ name: "Ada", age: 36 })
    })
    expect(blocked).toBe(true) // the compiled path was impossible here
    expect(result).toEqual({ value: { name: "Ada", age: 36 } })
  })

  test("reports issues with correct paths on the eval-free path", () => {
    const { result } = whileCodegenBlocked(() => {
      const schema = t.object({ name: t.string({ minLength: 1 }), age: t.integer() })
      return schema["~standard"].validate({ name: "", age: 3.5 })
    })
    expect(isIssues(result)).toBe(true)
    if (isIssues(result)) {
      const paths = result.issues.map((i) => i.path?.join("."))
      expect(paths).toContain("name")
      expect(paths).toContain("age")
    }
  })

  test("string formats still validate eval-free", () => {
    const good = whileCodegenBlocked(() =>
      t.object({ email: t.string({ format: "email" }) })["~standard"].validate({ email: "a@b.co" }),
    )
    const bad = whileCodegenBlocked(() =>
      t.object({ email: t.string({ format: "email" }) })["~standard"].validate({ email: "nope" }),
    )
    expect(good.result).toEqual({ value: { email: "a@b.co" } })
    expect(isIssues(bad.result)).toBe(true)
  })
})
