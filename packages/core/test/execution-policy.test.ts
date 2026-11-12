/** `defineExecutionPolicy`: what it accepts, what it refuses, and the frozen copy it returns. */
import { describe, expect, test } from "bun:test"
import { defineExecutionPolicy, type ExecutionPolicy } from "../src/execution-policy.ts"

/** Input the types forbid, handed to the runtime on purpose to see what it refuses. */
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the cast only widens a test value to the parameter under test; nothing reads it as `T`.
const wrong = (value: unknown): never => value as never

const valid: ExecutionPolicy = {
  filesystem: "cwd",
  network: "deny",
  timeMs: 5_000,
  capabilityCeiling: ["files.read", "net.fetch"],
}

const withField = (patch: Record<string, unknown>) => wrong({ ...valid, ...patch })

describe("defineExecutionPolicy", () => {
  test("returns a frozen copy and drops duplicate capabilities, keeping their order", () => {
    const input = {
      ...valid,
      capabilityCeiling: ["files.read", "net.fetch", "files.read"],
    }
    const policy = defineExecutionPolicy(input)
    expect(policy).toEqual(valid)
    expect(policy).not.toBe(input)
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.capabilityCeiling)).toBe(true)
    expect(input.capabilityCeiling).toHaveLength(3)
  })

  test("takes every filesystem scope and network setting it names, and an empty ceiling", () => {
    for (const filesystem of ["none", "cwd", "declared"] as const) {
      for (const network of ["deny", "allow"] as const) {
        expect(
          defineExecutionPolicy({ ...valid, filesystem, network, capabilityCeiling: [] }),
        ).toEqual({ filesystem, network, timeMs: 5_000, capabilityCeiling: [] })
      }
    }
  })

  test("refuses anything that is not an object", () => {
    for (const value of [null, undefined, "cwd", 1]) {
      expect(() => defineExecutionPolicy(wrong(value))).toThrow(
        new TypeError("execution policy: policy must be an object"),
      )
    }
  })

  test("refuses a filesystem scope and a network setting it does not know", () => {
    for (const filesystem of ["all", "", undefined, 1]) {
      expect(() => defineExecutionPolicy(withField({ filesystem }))).toThrow(
        new TypeError("execution policy: filesystem must be none, cwd, or declared"),
      )
    }
    for (const network of ["open", "", undefined, true]) {
      expect(() => defineExecutionPolicy(withField({ network }))).toThrow(
        new TypeError("execution policy: network must be deny or allow"),
      )
    }
  })

  test("refuses a time limit that is not a positive safe integer", () => {
    for (const timeMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "5000"]) {
      expect(() => defineExecutionPolicy(withField({ timeMs }))).toThrow(
        new RangeError("execution policy: timeMs must be a positive safe integer"),
      )
    }
    expect(defineExecutionPolicy(withField({ timeMs: 1 })).timeMs).toBe(1)
    expect(defineExecutionPolicy(withField({ timeMs: Number.MAX_SAFE_INTEGER })).timeMs).toBe(
      Number.MAX_SAFE_INTEGER,
    )
  })

  test("refuses a capability ceiling that is not a list of valid capabilities", () => {
    for (const capabilityCeiling of [
      "files.read",
      undefined,
      { length: 0 },
      ["Files.Read"],
      ["files read"],
      ["files.read", ""],
      [".files"],
    ]) {
      expect(() => defineExecutionPolicy(withField({ capabilityCeiling }))).toThrow(
        new TypeError("execution policy: capabilityCeiling must contain valid capabilities"),
      )
    }
  })
})
