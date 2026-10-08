import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"

type WebModule = typeof import("../../../src/index.ts")
const appAt = async (entry: string | undefined) => {
  if (entry === undefined) throw new Error("Both Nifra module paths are required")
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The measurement runner supplies the frozen or current Nifra module path; both implement the same application factory.
  const { createWebApp } = (await import(entry)) as WebModule
  return createWebApp({
    manifest: {
      routes: [
        {
          id: "plain",
          file: "plain.ts",
          pattern: "/",
          layoutIds: [],
          errorIds: [],
          load: async () => ({
            default: () => null,
            loader: async () => {
              await new Promise((accept) => setTimeout(accept, 20))
              return { title: "Public title" }
            },
          }),
        },
      ],
      layouts: {},
      errors: {},
    },
    llmsTxt: false,
    clientEntry: "/entry.js",
    adapter: {
      hydrationHead: () => "",
      renderToString: () => "<p>Public title</p>",
      renderToStream: () => {
        throw new Error("buffered benchmark")
      },
    },
  })
}
// Both copies run in one process, alternating per request: the loader's 20 ms timer jitters by
// more than the 3% gate across processes and over time, and alternation charges it to both alike.
const apps = {
  before: await appAt(process.env.NIFRA_COMPONENT_BASE_WEB),
  after: await appAt(process.env.NIFRA_COMPONENT_CURRENT_WEB),
}
type Side = keyof typeof apps
const call = async (side: Side) => {
  const response = await apps[side].fetch(new Request("https://fixture.test/"))
  if (response.status !== 200) throw new Error("Disabled fixture failed")
  return createHash("sha256")
    .update(await response.text())
    .update(JSON.stringify([...response.headers]))
    .digest("hex")
}
const fingerprints = { before: await call("before"), after: await call("after") }
const runs: Record<Side, { p50: number; p95: number }[]> = { before: [], after: [] }
for (let run = 0; run < 5; run++) {
  for (let index = 0; index < 30; index++) {
    await call("before")
    await call("after")
  }
  const durations: Record<Side, number[]> = { before: [], after: [] }
  for (let index = 0; index < 200; index++) {
    const order: readonly Side[] = index % 2 === 0 ? ["before", "after"] : ["after", "before"]
    for (const side of order) {
      const start = performance.now()
      if ((await call(side)) !== fingerprints[side])
        throw new Error("Non-deterministic disabled response")
      durations[side].push(performance.now() - start)
    }
  }
  for (const side of ["before", "after"] as const) {
    const sorted = durations[side].sort((a, b) => a - b)
    const p50 = sorted[99]
    const p95 = sorted[189]
    if (p50 === undefined || p95 === undefined) throw new Error("Incomplete disabled-mode samples")
    runs[side].push({ p50, p95 })
  }
}
const summary = (side: Side) => ({
  fingerprint: fingerprints[side],
  runs: runs[side],
  p95: runs[side].map((run) => run.p95).sort((a, b) => a - b)[2],
})
console.log(JSON.stringify({ before: summary("before"), after: summary("after") }))
