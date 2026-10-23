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

describe("publicErrorDetails edges", () => {
  test("a string error is its own message and a number falls back", () => {
    expect(publicErrorMessage("plain failure", "fallback")).toBe("plain failure")
    expect(publicErrorMessage(42, "fallback")).toBe("fallback")
  })

  test("an empty stack is left out and a long one is cut", () => {
    const empty = new Error("no stack")
    empty.stack = ""
    expect(publicErrorDetails(empty, "fallback", true)).toEqual({ message: "no stack" })
    const long = new Error("long stack")
    long.stack = "s".repeat(20_000)
    const details = publicErrorDetails(long, "fallback", true)
    expect(details.stack).toBe(`${"s".repeat(16 * 1024)}…`)
  })
})
