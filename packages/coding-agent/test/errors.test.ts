import { describe, expect, test } from "bun:test"
import { publicErrorDetails, publicErrorMessage } from "../src/errors.ts"

describe("publicErrorMessage", () => {
  test("keeps the actionable message but excludes an Error stack", () => {
    const error = new Error("missing export")
    expect(publicErrorMessage(error, "fallback")).toBe("missing export")
    expect(publicErrorMessage(error, "fallback")).not.toContain(error.stack)
  })

  test("supports structured errors without serializing stack data", () => {
    expect(
      publicErrorMessage({ message: "invalid manifest", stack: "secret stack" }, "fallback"),
    ).toBe("invalid manifest")
  })

  test("includes a bounded stack only when diagnostics are explicitly enabled", () => {
    const error = new Error("backend failed")
    expect(publicErrorDetails(error, "fallback")).toEqual({ message: "backend failed" })
    expect(publicErrorDetails(error, "fallback", true).stack).toContain("backend failed")
  })

  test("bounds unusually large diagnostics", () => {
    const message = publicErrorMessage(new Error("x".repeat(5000)), "fallback")
    expect(message.length).toBe(4097)
    expect(message.endsWith("…")).toBe(true)
  })
})
