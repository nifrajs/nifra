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
