import { describe, expect, test } from "bun:test"
import { pinned } from "../pinning.ts"
import { parseCpuList, parseCpuModel, parseProcStat, splitCores, stealShare } from "./host.ts"

describe("parseCpuList", () => {
  test("expands ranges and singles", () => {
    expect(parseCpuList("0-3,6\n")).toEqual([0, 1, 2, 3, 6])
    expect(parseCpuList("5")).toEqual([5])
  })

  test("rejects anything else", () => {
    for (const bad of ["", "0-", "a", "3-1", "0,,1", "0 1"]) {
      expect(() => parseCpuList(bad)).toThrow()
    }
  })
})

describe("splitCores", () => {
  const smtPairs = (pairs: readonly (readonly number[])[]) => (cpu: number) =>
    pairs.find((p) => p.includes(cpu)) ?? [cpu]

  test("a 4-vCPU runner with adjacent siblings splits by physical core", () => {
    expect(
      splitCores(
        [0, 1, 2, 3],
        smtPairs([
          [0, 1],
          [2, 3],
        ]),
      ),
    ).toEqual({
      server: [0, 1],
      load: [2, 3],
      cores: 2,
    })
  })

  test("interleaved siblings never land on both sides", () => {
    expect(
      splitCores(
        [0, 1, 2, 3],
        smtPairs([
          [0, 2],
          [1, 3],
        ]),
      ),
    ).toEqual({
      server: [0, 2],
      load: [1, 3],
      cores: 2,
    })
  })

  test("without SMT the odd core goes to the load side", () => {
    expect(splitCores([0, 1, 2], (cpu) => [cpu])).toEqual({ server: [0], load: [1, 2], cores: 3 })
  })

  test("siblings outside the allowed set are ignored", () => {
    expect(
      splitCores(
        [2, 3, 4, 5],
        smtPairs([
          [1, 2],
          [3, 4],
          [5, 6],
        ]),
      ),
    ).toEqual({
      server: [2],
      load: [3, 4, 5],
      cores: 3,
    })
  })

  test("refuses a host whose CPUs are one physical core", () => {
    expect(() => splitCores([0, 1], smtPairs([[0, 1]]))).toThrow(/at least 2 physical cores/)
  })
})

describe("/proc readers", () => {
  test("total excludes guest time, steal is the eighth field", () => {
    const stat = "cpu  100 5 50 800 10 1 2 32 7 0\ncpu0 50 2 25 400 5 0 1 16 3 0\nintr 1"
    expect(parseProcStat(stat)).toEqual({ total: 1000, steal: 32 })
    expect(() => parseProcStat("intr 1")).toThrow()
  })

  test("steal share is the steal delta over the total delta", () => {
    expect(stealShare({ total: 1000, steal: 10 }, { total: 3000, steal: 50 })).toBe(0.02)
    expect(stealShare({ total: 1000, steal: 10 }, { total: 1000, steal: 10 })).toBeUndefined()
  })

  test("cpu model is the first model name line", () => {
    const info = "processor\t: 0\nmodel name\t: AMD EPYC 7763 64-Core Processor\nprocessor\t: 1\n"
    expect(parseCpuModel(info)).toBe("AMD EPYC 7763 64-Core Processor")
    expect(parseCpuModel("processor\t: 0\n")).toBeUndefined()
  })
})

describe("pinned", () => {
  test("prefixes taskset only when a CPU list is set", () => {
    expect(pinned(["oha", "-n", "5"], "2,3")).toEqual(["taskset", "-c", "2,3", "oha", "-n", "5"])
    expect(pinned(["oha"], undefined)).toEqual(["oha"])
  })
})
