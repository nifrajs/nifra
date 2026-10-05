import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"

// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The measurement runner supplies the frozen or current Nifra module path; both implement the same application factory.
const { createWebApp } = (await import(
  process.env.NIFRA_COMPONENT_BASE_WEB!
)) as typeof import("../../../src/index.ts")
const app = createWebApp({
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
const call = async () => {
  const response = await app.fetch(new Request("https://fixture.test/"))
  if (response.status !== 200) throw new Error("Disabled fixture failed")
  return createHash("sha256")
    .update(await response.text())
    .update(JSON.stringify([...response.headers]))
    .digest("hex")
}
const fingerprint = await call()
const runs = []
for (let run = 0; run < 5; run++) {
  for (let index = 0; index < 30; index++) await call()
  const durations = []
  for (let index = 0; index < 200; index++) {
    const start = performance.now()
    if ((await call()) !== fingerprint) throw new Error("Non-deterministic disabled response")
    durations.push(performance.now() - start)
  }
  durations.sort((a, b) => a - b)
  const p50 = durations[99]
  const p95 = durations[189]
  if (p50 === undefined || p95 === undefined) throw new Error("Incomplete disabled-mode samples")
  runs.push({ p50, p95 })
}
console.log(
  JSON.stringify({
    fingerprint,
    runs,
    p95: [...runs.map((run) => run.p95)].sort((a, b) => a - b)[2],
  }),
)
