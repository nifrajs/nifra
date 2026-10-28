import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A phase of synchronous hooks must not grow the stack with its length. Bun runs `return f()` as a
 * tail call, so only Node (V8) shows a recursive stage overflowing; this test bundles a probe app
 * and runs it on a real Node.
 */

const HOOKS = 30_000
const SRC = join(import.meta.dir, "../src")

const PROBE = `
import { server } from ${JSON.stringify(join(SRC, "index.ts"))}
import { nodeDirect } from ${JSON.stringify(join(SRC, "node-direct.ts"))}

const phases = {
  derive: (app) => app.derive(() => ({})),
  before: (app) => app.beforeHandle(() => undefined),
  after: (app) => app.afterHandle((result) => result),
}
const answers = {}
for (const [name, add] of Object.entries(phases)) {
  let app = server().use(nodeDirect())
  for (let i = 0; i < ${HOOKS}; i++) app = add(app)
  app = app.get("/x", () => "ok")
  answers[name + ":web"] = (await app.fetch(new Request("http://localhost/x"))).status
  answers[name + ":node"] = (await app.resolveNode(new Request("http://localhost/x"))).status
}
console.log(JSON.stringify(answers))
`

test("a phase of thousands of synchronous hooks runs on Node's stack, on the Web and Node-direct lanes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nifra-hook-depth-"))
  try {
    const entry = join(dir, "probe.ts")
    await writeFile(entry, PROBE)
    const built = await Bun.build({ entrypoints: [entry], target: "node", outdir: dir })
    expect(built.success).toBe(true)
    const proc = Bun.spawn([Bun.which("node") ?? "node", join(dir, "probe.js")], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(await proc.exited, err).toBe(0)
    expect(JSON.parse(out.trim().split("\n").pop() ?? "")).toEqual({
      "derive:web": 200,
      "derive:node": 200,
      "before:web": 200,
      "before:node": 200,
      "after:web": 200,
      "after:node": 200,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60_000)
