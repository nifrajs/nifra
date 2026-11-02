import { expect, test } from "bun:test"
import type { HttpMemoryRuntime } from "../../site/shared/data/memory-types.ts"
import { assertPartialMemoryHost, fullMemoryBatch, type MemoryCapture } from "./publish.ts"

function capture(
  runtime: HttpMemoryRuntime,
  cpu = "Apple M3 Max",
  platform = "darwin",
): MemoryCapture {
  const runtimeVersion = runtime === "node" ? "v26.12.0" : runtime === "bun" ? "1.4.4" : "2.9.7"
  const protocol =
    runtime === "node"
      ? "fresh-native-node-v1"
      : runtime === "bun"
        ? "fresh-native-bun-v1"
        : "fresh-native-deno-v1"
  return {
    runtime,
    runtimeVersion,
    node: "v26.12.0",
    date: "2026-10-30T00:00:00.000Z",
    platform,
    cpu,
    revision: "a".repeat(40),
    workspaceArtifactSHA256: "b".repeat(64),
    protocol,
    rounds: 5,
    requestsPerPhase: 50_000,
    connections: 50,
    rows: [
      {
        name: "Nifra",
        version: "1.0.0",
        nifra: true,
        readyRssMiB: 10,
        getRssMiB: 20,
        postRssMiB: 30,
        postHeapMiB: 5,
        peakRssMiB: 40,
        postRssMinMiB: 29,
        postRssMaxMiB: 31,
      },
    ],
  }
}

test("a full memory batch accepts a new host and contains each runtime", () => {
  const batch = fullMemoryBatch([
    capture("node", "Apple M4 Max"),
    capture("bun", "Apple M4 Max"),
    capture("deno", "Apple M4 Max"),
  ])
  expect(Object.keys(batch)).toEqual(["node", "bun", "deno"])
  expect(batch.node?.cpu).toBe("Apple M4 Max")
})

test("a full memory batch rejects missing, duplicate, or cross-host captures", () => {
  expect(() => fullMemoryBatch([capture("node"), capture("bun")])).toThrow(
    "requires 3 runtime captures",
  )
  expect(() => fullMemoryBatch([capture("node"), capture("node"), capture("deno")])).toThrow(
    "duplicate node",
  )
  expect(() =>
    fullMemoryBatch([capture("node"), capture("bun"), capture("deno", "other CPU")]),
  ).toThrow("one CPU and platform")
})

test("partial memory publication still refuses captures from a different host", () => {
  const retained = { node: capture("node", "Apple M3 Max"), bun: capture("bun", "Apple M3 Max") }
  expect(() => assertPartialMemoryHost(capture("deno", "Apple M3 Max"), retained)).not.toThrow()
  expect(() => assertPartialMemoryHost(capture("deno", "Apple M4 Max"), retained)).toThrow(
    "refusing to merge deno memory capture",
  )
})
