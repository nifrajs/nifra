import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnChild } from "../src/mcp-exec.ts"

const root = mkdtempSync(join(tmpdir(), "nifra-mcp-child-exit-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

mkdirSync(join(root, "backend"), { recursive: true })
mkdirSync(join(root, "routes"), { recursive: true })
symlinkSync(resolve(import.meta.dir, "../../../node_modules"), join(root, "node_modules"))
writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", private: true }))
writeFileSync(join(root, "routes", "index.tsx"), "export default () => null\n")
writeFileSync(
  join(root, "nifra.config.ts"),
  'export const adapter = {}\nexport const clientModule = "@nifrajs/web-react/client"\n',
)
// A live handle, as a database pool or a metrics interval leaves: the child must not wait on it.
writeFileSync(
  join(root, "backend", "app.ts"),
  [
    'import { server } from "@nifrajs/core"',
    'import { websocket } from "@nifrajs/core/ws"',
    "setInterval(() => {}, 1_000)",
    "export const backend = server()",
    "  .use(websocket())",
    '  .get("/health", () => ({ ok: true }))',
    '  .ws("/echo", { message: (ws, message) => ws.send(message) })',
    "",
  ].join("\n"),
)

test("nifra_run and nifra_ws answer without waiting on the app's open handles", async () => {
  const started = Date.now()
  const ran: unknown = JSON.parse(
    await spawnChild("mcp-run", root, { requests: [{ path: "/health" }] }, "run"),
  )
  const echoed: unknown = JSON.parse(
    await spawnChild("mcp-ws", root, { path: "/echo", messages: ["hi"], expectMessages: 1 }, "ws"),
  )
  expect(ran).toHaveProperty("results.0.body.ok", true)
  expect(echoed).toHaveProperty("ok", true)
  // The child timeout is 30s; a child that did not exit on its own took all of it.
  expect(Date.now() - started).toBeLessThan(10_000)
}, 70_000)

test("project children start from the running Bun, not whatever `bun` PATH finds", async () => {
  const script = join(root, "probe.ts")
  writeFileSync(
    script,
    [
      `import { spawnChild } from ${JSON.stringify(resolve(import.meta.dir, "../src/mcp-exec.ts"))}`,
      `import { collectTestResult } from ${JSON.stringify(resolve(import.meta.dir, "../src/test-tool.ts"))}`,
      `const ran = await spawnChild("mcp-run", ${JSON.stringify(root)}, { requests: [{ path: "/health" }] }, "run")`,
      `const tested = await collectTestResult(${JSON.stringify(root)}, { pattern: "health.test.ts" })`,
      "process.stdout.write(JSON.stringify({ ran: JSON.parse(ran), tested: tested.ok }))",
      "process.exit(0)",
      "",
    ].join("\n"),
  )
  writeFileSync(
    join(root, "health.test.ts"),
    'import { expect, test } from "bun:test"\ntest("ok", () => expect(1).toBe(1))\n',
  )
  // An MCP client often launches the server with a minimal PATH that has no `bun` on it.
  const proc = Bun.spawn([process.execPath, script], {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? root },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const result: unknown = JSON.parse(out)
  expect(result).toHaveProperty("ran.results.0.body.ok", true)
  expect(result).toHaveProperty("tested", true)
}, 70_000)
