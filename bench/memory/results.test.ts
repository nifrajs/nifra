import { expect, test } from "bun:test"
import { memoryCapture } from "./results.ts"

const frameworkTargets = ["nifra", "fastify", "elysia", "hono", "express"] as const
const targets = {
  node: frameworkTargets,
  bun: [...frameworkTargets, "bun-native"],
  deno: [...frameworkTargets, "deno-raw"],
} as const
type Runtime = keyof typeof targets

function fixture(runtime: Runtime = "node") {
  const snapshot = (rss: number) => ({
    rss,
    heapTotal: 1000,
    heapUsed: 500,
    external: 20,
    arrayBuffers: 10,
    peakRss: rss + 100,
  })
  return {
    meta: {
      mode: "memory",
      suite: "realworld",
      packaging: "native",
      completed: true,
      workspaceArtifactSHA256: "b".repeat(64),
      rounds: 3,
      requests: 20000,
      connections: 50,
      date: "2026-10-21T00:00:00.000Z",
      node: "v26.12.0",
      runtime,
      runtimeVersion: runtime === "node" ? "v26.12.0" : runtime === "bun" ? "1.4.4" : "2.9.7",
      platform: "darwin",
      cpu: "test",
      head: "a".repeat(40),
      versions: {
        "@nifrajs/core": "5.5.1",
        fastify: "5.12.7",
        elysia: "1.4.30",
        hono: "4.13.13",
        express: "5.3.0",
      },
    },
    samples: targets[runtime].flatMap((target) =>
      [0, 1, 2].map((round) => ({
        target,
        round,
        snapshots: {
          ready: snapshot(1000),
          get: snapshot(2000),
          post: snapshot([3000, 9000, 4000][round] ?? 0),
        },
      })),
    ),
  }
}
test("memory summaries use fresh-process medians and retain the observed range", () => {
  for (const runtime of ["node", "bun", "deno"] as const) {
    const capture = memoryCapture(fixture(runtime))
    expect(capture.runtime).toBe(runtime)
    expect(capture.rows).toHaveLength(5)
    expect(capture.rows[0]?.postRssMiB).toBe(4000 / 1048576)
    expect(capture.rows[0]?.postRssMinMiB).toBe(3000 / 1048576)
    expect(capture.rows[0]?.postRssMaxMiB).toBe(9000 / 1048576)
    expect(capture.protocol).toBe(`fresh-native-${runtime}-v1`)
    expect(capture.workspaceArtifactSHA256).toBe("b".repeat(64))
  }
})
test("mixed packaging, profiler data, partial matrices and duplicate samples cannot be published", () => {
  for (const mutate of [
    (data: ReturnType<typeof fixture>) => {
      data.meta.packaging = "bundled-nifra"
    },
    (data: ReturnType<typeof fixture>) => {
      data.meta.mode = "heap"
    },
    (data: ReturnType<typeof fixture>) => {
      data.meta.completed = false
    },
    (data: ReturnType<typeof fixture>) => {
      data.meta.rounds = 1
    },
    (data: ReturnType<typeof fixture>) => {
      data.samples.pop()
    },
    (data: ReturnType<typeof fixture>) => {
      data.samples[1] = data.samples[0]!
    },
    (data: ReturnType<typeof fixture>) => {
      data.samples[0]!.snapshots.post.rss = Number.NaN
    },
  ]) {
    const data = fixture()
    mutate(data)
    expect(() => memoryCapture(data)).toThrow()
  }
})
