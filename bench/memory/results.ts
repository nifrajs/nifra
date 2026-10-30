import { z } from "zod"
import type { HttpMemoryCapture, HttpMemoryRuntime } from "../../site/shared/data/memory-types.ts"

const bytes = z.number().int().nonnegative().finite()
// Runtime compatibility APIs can round heapTotal below heapUsed (observed with Bun).
// Keep both source values and validate their shape without imposing V8's accounting invariant.
const snapshot = z.object({
  rss: bytes.positive(),
  heapTotal: bytes,
  heapUsed: bytes,
  external: bytes,
  arrayBuffers: bytes,
  peakRss: bytes.positive(),
})

const runtimes = ["node", "bun", "deno"] as const satisfies readonly HttpMemoryRuntime[]
const allTargets = [
  "nifra",
  "fastify",
  "elysia",
  "hono",
  "express",
  "bun-native",
  "deno-raw",
] as const
const expectedTargets: Record<HttpMemoryRuntime, readonly (typeof allTargets)[number][]> = {
  node: ["nifra", "fastify", "elysia", "hono", "express"],
  bun: ["nifra", "fastify", "elysia", "hono", "express", "bun-native"],
  deno: ["nifra", "fastify", "elysia", "hono", "express", "deno-raw"],
}
const publishedTargets = ["nifra", "fastify", "elysia", "hono", "express"] as const
const names = {
  nifra: "Nifra",
  fastify: "Fastify",
  elysia: "Elysia",
  hono: "Hono",
  express: "Express",
}

const parsedResults = z.object({
  meta: z.object({
    mode: z.literal("memory"),
    suite: z.literal("realworld"),
    packaging: z.literal("native"),
    completed: z.literal(true),
    workspaceArtifactSHA256: z.string().regex(/^[a-f\d]{64}$/),
    rounds: z.number().int().min(3).max(100),
    requests: z.number().int().min(20000),
    connections: z.number().int().positive(),
    date: z.iso.datetime(),
    node: z.string().min(1),
    runtime: z.enum(runtimes),
    runtimeVersion: z.string().min(1),
    platform: z.string().min(1),
    cpu: z.string().min(1),
    head: z.string().regex(/^[a-f\d]{40}$/),
    versions: z.record(z.string(), z.string().min(1)),
  }),
  samples: z.array(
    z.object({
      target: z.enum(allTargets),
      round: z.number().int().nonnegative(),
      snapshots: z.object({ ready: snapshot, get: snapshot, post: snapshot }),
    }),
  ),
})

const median = (values: number[]): number => {
  const xs = [...values].sort((a, b) => a - b)
  const middle = Math.floor(xs.length / 2)
  return xs.length % 2 ? (xs[middle] ?? 0) : ((xs[middle - 1] ?? 0) + (xs[middle] ?? 0)) / 2
}
const mib = (value: number): number => value / 1048576

export function memoryCapture(input: unknown): HttpMemoryCapture {
  const { meta, samples } = parsedResults.parse(input)
  const expected = expectedTargets[meta.runtime]
  const keys = new Set<string>()
  for (const sample of samples) {
    const key = `${sample.target}/${sample.round}`
    if (!(expected as readonly string[]).includes(sample.target))
      throw new Error(`unexpected ${meta.runtime} memory target: ${sample.target}`)
    if (sample.round >= meta.rounds || keys.has(key))
      throw new Error(`duplicate or out-of-range memory sample: ${key}`)
    keys.add(key)
  }
  if (samples.length !== expected.length * meta.rounds) throw new Error("incomplete memory matrix")

  return {
    date: meta.date.slice(0, 10),
    runtime: meta.runtime,
    runtimeVersion: meta.runtimeVersion.replace(/^v/, ""),
    node: meta.node.replace(/^v/, ""),
    platform: meta.platform,
    cpu: meta.cpu,
    revision: meta.head,
    workspaceArtifactSHA256: meta.workspaceArtifactSHA256,
    protocol: `fresh-native-${meta.runtime}-v1`,
    rounds: meta.rounds,
    requestsPerPhase: meta.requests,
    connections: meta.connections,
    rows: publishedTargets.map((target) => {
      const xs = samples.filter((sample) => sample.target === target)
      if (xs.length !== meta.rounds) throw new Error(`missing memory samples: ${target}`)
      const version = meta.versions[target === "nifra" ? "@nifrajs/core" : target]
      if (version === undefined) throw new Error(`missing package version: ${target}`)
      const postRss = xs.map((sample) => sample.snapshots.post.rss)
      const row = {
        name: names[target],
        version,
        readyRssMiB: mib(median(xs.map((sample) => sample.snapshots.ready.rss))),
        getRssMiB: mib(median(xs.map((sample) => sample.snapshots.get.rss))),
        postRssMiB: mib(median(postRss)),
        postHeapMiB: mib(median(xs.map((sample) => sample.snapshots.post.heapUsed))),
        peakRssMiB: mib(median(xs.map((sample) => sample.snapshots.post.peakRss))),
        postRssMinMiB: mib(Math.min(...postRss)),
        postRssMaxMiB: mib(Math.max(...postRss)),
      }
      return target === "nifra" ? { ...row, nifra: true } : row
    }),
  }
}
