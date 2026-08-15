import { expect, test } from "bun:test"

test("content index client bundle stays within its opt-in gzip budget", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
    target: "browser",
    minify: true,
    external: ["marked", "yaml"],
  })
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"))
  const output = result.outputs[0]
  if (output === undefined) throw new Error("content index bundle produced no output")
  const bytes = new Uint8Array(await output.arrayBuffer())
  const gzipBytes = Bun.gzipSync(bytes).byteLength
  // This covers the opt-in content module, with Markdown/YAML dependencies externalized. Keep the
  // ceiling deliberate and review it from a measured build when the index contract changes.
  expect(gzipBytes).toBeLessThanOrEqual(12_000)
})
