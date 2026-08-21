import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("coding-agent owns the one-way jobs edge and jobs stays agent-free", async () => {
  const codingManifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    dependencies?: Record<string, string>
  }
  const jobsManifest = JSON.parse(
    await readFile(new URL("../../jobs/package.json", import.meta.url), "utf8"),
  ) as {
    dependencies?: Record<string, string>
  }
  expect(codingManifest.dependencies?.["@nifrajs/jobs"]).toBe("workspace:*")
  expect(jobsManifest.dependencies?.["@nifrajs/agent"]).toBeUndefined()
  expect(jobsManifest.dependencies?.["@nifrajs/coding-agent"]).toBeUndefined()
  const source = await readFile(new URL("../../jobs/src/index.ts", import.meta.url), "utf8")
  expect(source).not.toMatch(/agent|coding-agent/i)
})
