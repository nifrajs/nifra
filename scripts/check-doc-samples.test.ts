import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("a docs tree with no checkable sample fails the gate instead of passing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "doc-samples-"))
  const gate = join(import.meta.dir, "check-doc-samples.ts")
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { main } from ${JSON.stringify(gate)}; main(${JSON.stringify(root)})`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code).toBe(1)
  expect(stderr).toContain("nothing was checked")
})
