import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectMonorepoApps, loadAppSummary } from "../src/app-summary.ts"
import { answerAppSummary, serveAppSummaryChild } from "../src/app-summary-child.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nifra-config-isolation-"))
  roots.push(root)
  return root
}

/** A config line that records which process evaluated it. */
const RECORD_PID =
  'import { appendFileSync } from "node:fs"\n' +
  'appendFileSync(new URL("./pids.log", import.meta.url), String(process.pid) + "\\n")\n'

function writeApp(dir: string, config: string): void {
  mkdirSync(join(dir, "routes"), { recursive: true })
  writeFileSync(join(dir, "routes", "index.tsx"), "export default () => null\n")
  writeFileSync(join(dir, "nifra.config.ts"), config)
}

const APP_CONFIG =
  RECORD_PID +
  "export const adapter = {}\n" +
  'export const clientModule = "@nifrajs/web-react/client"\n' +
  'export const devDatabase = { kind: "sqlite", file: "./data/app.db" }\n'

function pids(dir: string): string[] {
  const file = join(dir, "pids.log")
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []
}

const dig = (value: unknown, ...path: Array<string | number>): unknown =>
  path.reduce<unknown>(
    (at, key) => (typeof at === "object" && at !== null ? Reflect.get(at, key) : undefined),
    value,
  )

/** Drive `nifra mcp` over stdio until every expected id has answered; returns the server's pid. */
async function mcpRpc(
  dir: string,
  messages: object[],
  ids: number[],
): Promise<{ pid: number; byId: Record<number, unknown> }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "mcp"], {
    cwd: dir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  for (const message of messages) proc.stdin.write(`${JSON.stringify(message)}\n`)
  const byId: Record<number, unknown> = {}
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  const deadline = Date.now() + 45_000
  try {
    while (ids.some((id) => byId[id] === undefined) && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((done) =>
          setTimeout(() => done({ done: true, value: undefined }), 45_000),
        ),
      ])
      if (chunk.done) break
      buffered += decoder.decode(chunk.value, { stream: true })
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("{")) continue
        const parsed: unknown = JSON.parse(line)
        const id = dig(parsed, "id")
        if (typeof id === "number") byId[id] = parsed
      }
    }
  } finally {
    reader.cancel().catch(() => {})
    proc.kill()
    await proc.exited.catch(() => 0)
  }
  return { pid: proc.pid, byId }
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
}

const toolNames = (response: unknown): unknown[] => {
  const tools = dig(response, "result", "tools")
  return Array.isArray(tools) ? tools.map((tool) => dig(tool, "name")) : []
}

describe("nifra mcp never evaluates nifra.config.ts in its own process", () => {
  test("a single app: startup, tools/list and nifra_context load the config elsewhere", async () => {
    const root = tempRoot()
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", private: true }))
    writeApp(root, APP_CONFIG)
    const { pid, byId } = await mcpRpc(
      root,
      [
        INITIALIZE,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "nifra_context", arguments: {} },
        },
      ],
      [1, 2, 3],
    )
    expect(toolNames(byId[2])).toContain("nifra_context")
    expect(String(dig(byId[3], "result", "content", 0, "text"))).toContain("# nifra project")
    const seen = pids(root)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen).not.toContain(String(pid))
  }, 60_000)

  test("a config that exits takes down only its own process", async () => {
    const root = tempRoot()
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", private: true }))
    writeApp(root, "process.exit(7)\n")
    const { byId } = await mcpRpc(
      root,
      [
        INITIALIZE,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "nifra_context", arguments: {} },
        },
      ],
      [1, 2, 3],
    )
    expect(toolNames(byId[2])).toContain("nifra_context")
    expect(dig(byId[3], "result", "isError")).toBe(true)
  }, 60_000)

  test("a monorepo root: detection and each app's tools load the configs elsewhere", async () => {
    const root = tempRoot()
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mono", private: true }))
    writeFileSync(
      join(root, "nifra.config.ts"),
      `${RECORD_PID}export const apps = { web: "./apps/web" }\n`,
    )
    const web = join(root, "apps", "web")
    writeApp(web, APP_CONFIG)
    const { pid, byId } = await mcpRpc(
      root,
      [
        INITIALIZE,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ],
      [1, 2],
    )
    expect(toolNames(byId[2])).toContain("nifra_web_context")
    for (const dir of [root, web]) {
      const seen = pids(dir)
      expect(seen.length).toBeGreaterThan(0)
      expect(seen).not.toContain(String(pid))
    }
  }, 60_000)
})

describe("loadAppSummary", () => {
  test("returns the config's serializable fields and the backend, evaluating the config elsewhere", async () => {
    const root = tempRoot()
    writeApp(
      root,
      `${RECORD_PID}export const adapter = {}\n` +
        'export const clientModule = "./client.tsx"\n' +
        'export const apiPrefix = "/api"\n' +
        "export const apiStrip = true\n" +
        'export const vitePlugins = [{ name: "one" }, () => {}]\n',
    )
    mkdirSync(join(root, "backend"))
    writeFileSync(join(root, "backend", "app.ts"), 'export const backend = { kind: "backend" }\n')
    const app = await loadAppSummary(root, "out")
    expect(app).toEqual({
      cwd: root,
      configPath: join(root, "nifra.config.ts"),
      routesDir: join(root, "routes"),
      outDir: join(root, "out"),
      framework: {
        clientModule: join(root, "client.tsx").replaceAll("\\", "/"),
        apiPrefix: "/api",
        apiStrip: true,
      },
      resolvedPlugins: { vitePlugins: [{ name: "one" }, {}], clientPlugins: [], serverPlugins: [] },
      backend: { kind: "backend" },
    })
    expect(pids(root)).toHaveLength(1)
    expect(pids(root)).not.toContain(String(process.pid))
  }, 30_000)

  test("reuses the config answer across backend edits and rereads it after a config edit", async () => {
    const root = tempRoot()
    const config = `${APP_CONFIG}export const apiPrefix = "/api"\n`
    writeApp(root, config)
    mkdirSync(join(root, "backend"))
    const backend = join(root, "backend", "app.ts")
    writeFileSync(backend, "export const backend = 1\n")
    expect((await loadAppSummary(root, "dist", { importQuery: "a" })).backend).toBe(1)
    writeFileSync(backend, "export const backend = 22\n")
    const afterBackendEdit = await loadAppSummary(root, "dist", { importQuery: "b" })
    expect(afterBackendEdit.backend).toBe(22)
    expect(afterBackendEdit.framework.apiPrefix).toBe("/api")
    expect(pids(root)).toHaveLength(1)
    writeFileSync(join(root, "nifra.config.ts"), config.replace('"/api"', '"/v2/api"'))
    const afterConfigEdit = await loadAppSummary(root, "dist", { importQuery: "c" })
    expect(afterConfigEdit.framework.apiPrefix).toBe("/v2/api")
    expect(pids(root)).toHaveLength(2)
  }, 30_000)

  test("throws loadApp's message for an invalid config", async () => {
    const root = tempRoot()
    writeApp(root, "export const adapter = {}\n")
    await expect(loadAppSummary(root)).rejects.toThrow(
      "nifra.config.ts must export `adapter` (a render adapter object) and `clientModule` (a string).",
    )
  }, 30_000)

  test("reports a config that exits before answering", async () => {
    const root = tempRoot()
    writeApp(root, "process.exit(7)\n")
    await expect(loadAppSummary(root)).rejects.toThrow("exited with code 7 before answering")
  }, 30_000)

  test("kills a config that never finishes loading at the deadline", async () => {
    const root = tempRoot()
    writeApp(root, `${RECORD_PID}await new Promise(() => setInterval(() => {}, 1_000))\n`)
    await expect(loadAppSummary(root, "dist", { timeoutMs: 2_000 })).rejects.toThrow(
      "did not load within 2s and its process was killed",
    )
    const [pid] = pids(root)
    expect(pid).toBeDefined()
    expect(() => process.kill(Number(pid), 0)).toThrow()
  }, 30_000)

  test("refuses a missing routes/ without starting a process", async () => {
    const root = tempRoot()
    writeFileSync(join(root, "nifra.config.ts"), RECORD_PID)
    await expect(loadAppSummary(root)).rejects.toThrow("no routes/ directory")
    expect(pids(root)).toEqual([])
  })
})

describe("detectMonorepoApps", () => {
  test("reads the root's apps, evaluating the config elsewhere", async () => {
    const root = tempRoot()
    writeFileSync(
      join(root, "nifra.config.ts"),
      `${RECORD_PID}export const apps = { dash: "./apps/dash", bad: 1 }\n`,
    )
    expect(await detectMonorepoApps(root)).toEqual({ apps: { dash: "./apps/dash" } })
    expect(pids(root)).not.toContain(String(process.pid))
  }, 30_000)

  test("is null for an app, a config without apps, and a config that throws", async () => {
    const app = tempRoot()
    writeApp(app, RECORD_PID)
    expect(await detectMonorepoApps(app)).toBeNull()
    expect(pids(app)).toEqual([])

    const noApps = tempRoot()
    writeFileSync(join(noApps, "nifra.config.ts"), "export const adapter = {}\n")
    expect(await detectMonorepoApps(noApps)).toBeNull()

    const throws = tempRoot()
    writeFileSync(join(throws, "nifra.config.ts"), 'throw new Error("boom")\n')
    expect(await detectMonorepoApps(throws)).toBeNull()

    const hangs = tempRoot()
    writeFileSync(
      join(hangs, "nifra.config.ts"),
      'await new Promise(() => setInterval(() => {}, 1_000))\nexport const apps = { dash: "./apps/dash" }\n',
    )
    expect(await detectMonorepoApps(hangs, { timeoutMs: 1_000 })).toBeNull()
  }, 30_000)
})

describe("app summary child", () => {
  const streamOf = (text: string): ReadableStream<Uint8Array> => new Blob([text]).stream()

  test("answers a token-prefixed line and refuses a malformed request", async () => {
    const root = tempRoot()
    writeFileSync(join(root, "nifra.config.ts"), 'export const apps = { dash: "./apps/dash" }\n')
    const token = "0123456789abcdef0123"
    const lines: string[] = []
    const write = async (line: string): Promise<void> => {
      lines.push(line)
    }
    expect(
      await serveAppSummaryChild(
        root,
        streamOf(JSON.stringify({ token, kind: "monorepo" })),
        write,
      ),
    ).toBe(true)
    expect(lines).toEqual([
      `${token} ${JSON.stringify({ ok: true, apps: { dash: "./apps/dash" } })}\n`,
    ])
    for (const bad of [
      "not json",
      "null",
      JSON.stringify({ token: "x", kind: "app" }),
      JSON.stringify({ token, kind: "other" }),
    ]) {
      expect(await serveAppSummaryChild(root, streamOf(bad), write)).toBe(false)
    }
    expect(lines).toHaveLength(1)
  })

  test("answers ok: false with the load error", async () => {
    const root = tempRoot()
    expect(await answerAppSummary(root, { kind: "app" })).toEqual({
      ok: false,
      message: expect.stringContaining("no nifra.config.ts or backend/framework.ts found"),
    })
  })
})
