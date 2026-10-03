import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { forgetAutoLoadedEnv } from "../src/env-file.ts"
import {
  askProjectChild,
  createAppSurface,
  detectMonorepoIsolated,
  isolateResources,
  isolateTools,
} from "../src/mcp-isolate.ts"
import { answerProjectRequest, serveProjectChild } from "../src/mcp-project-child.ts"

const REPO_NODE_MODULES = resolve(import.meta.dir, "../../../node_modules")
const CLI = join(import.meta.dir, "../src/cli.ts")

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nifra-mcp-isolation-"))
  roots.push(root)
  return root
}

/** The script a process runs: the server is `cli.ts`, a project subprocess `mcp-project-child.ts`. */
const SCRIPT = 'String(process.argv[1]).split("/").pop()'

/** A module line that records which process evaluated it and what it saw of the environment. */
const record = (log: string): string =>
  'import { appendFileSync } from "node:fs"\n' +
  `appendFileSync(new URL(${JSON.stringify(log)}, import.meta.url), JSON.stringify({ pid: process.pid, script: ${SCRIPT}, secret: process.env.NIFRA_PROBE_SECRET ?? null }) + "\\n")\n`

const APP_CONFIG =
  `${record("./config.log")}export const adapter = {}\n` +
  'export const clientModule = "@nifrajs/web-react/client"\n' +
  'export const devDatabase = { kind: "sqlite", file: "./data/app.db" }\n'

const BACKEND =
  record("../backend.log") +
  'import { server } from "@nifrajs/core"\n' +
  'import { mcp } from "@nifrajs/core/mcp"\n' +
  'const any = { "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) } }\n' +
  "export const backend = server()\n" +
  "  .use(mcp())\n" +
  '  .get("/health", () => ({ ok: true }))\n' +
  '  .tool("whoami", { description: "Who runs this tool", input: any }, () => ({\n' +
  "    pid: process.pid,\n" +
  `    script: ${SCRIPT},\n` +
  "    secret: process.env.NIFRA_PROBE_SECRET ?? null,\n" +
  "    shell: process.env.NIFRA_PROBE_SHELL ?? null,\n" +
  "  }))\n"

/** A web app with a config, a page, a backend declaring `whoami`, and the repo's packages. */
function writeApp(dir: string, config = APP_CONFIG, backend = BACKEND): void {
  mkdirSync(join(dir, "routes"), { recursive: true })
  writeFileSync(join(dir, "routes", "index.tsx"), "export default () => null\n")
  writeFileSync(join(dir, "nifra.config.ts"), config)
  mkdirSync(join(dir, "backend"), { recursive: true })
  writeFileSync(join(dir, "backend", "app.ts"), backend)
  if (!existsSync(join(dir, "node_modules")))
    symlinkSync(REPO_NODE_MODULES, join(dir, "node_modules"))
}

interface Seen {
  readonly pid: number
  readonly script: string
  readonly secret: string | null
}

const PROJECT_CHILD = "mcp-project-child.ts"

function seen(dir: string, log: string): Seen[] {
  const file = join(dir, log)
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line): Seen => JSON.parse(line))
}

const dig = (value: unknown, ...path: Array<string | number>): unknown =>
  path.reduce<unknown>(
    (at, key) => (typeof at === "object" && at !== null ? Reflect.get(at, key) : undefined),
    value,
  )

/** Drive `nifra mcp` over stdio until every expected id has answered; returns the server's pid. */
async function mcpRpc(
  cwd: string,
  args: string[],
  messages: object[],
  ids: number[],
  env: Record<string, string> = {},
): Promise<{ pid: number; byId: Record<number, unknown> }> {
  const base = { ...process.env, ...env }
  delete base.NIFRA_PROBE_SECRET
  const proc = Bun.spawn([process.execPath, CLI, "mcp", ...args], {
    cwd,
    env: base,
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
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" }
const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
})

const toolNames = (response: unknown): unknown[] => {
  const tools = dig(response, "result", "tools")
  return Array.isArray(tools) ? tools.map((tool) => dig(tool, "name")) : []
}
const toolText = (response: unknown): string =>
  String(dig(response, "result", "content", 0, "text") ?? "")

describe("nifra mcp runs no project code in its own process", () => {
  test("started in the project: every tool, resource and declared tool runs in a subprocess that loads .env", async () => {
    const root = tempRoot()
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", private: true }))
    writeFileSync(join(root, ".env"), "NIFRA_PROBE_SECRET=from-dotenv\n")
    writeApp(root)
    const { pid, byId } = await mcpRpc(
      root,
      [],
      [
        INITIALIZE,
        INITIALIZED,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        call(3, "nifra_context"),
        call(4, "whoami"),
        { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "nifra://routes" } },
      ],
      [1, 2, 3, 4, 5],
    )
    expect(toolNames(byId[2])).toContain("nifra_context")
    expect(toolNames(byId[2])).toContain("whoami")
    expect(toolText(byId[3])).toContain("# nifra project")
    const whoami: unknown = JSON.parse(toolText(byId[4]))
    expect(dig(whoami, "secret")).toBe("from-dotenv")
    expect(dig(whoami, "script")).toBe(PROJECT_CHILD)
    expect(dig(whoami, "pid")).not.toBe(pid)
    expect(String(dig(byId[5], "result", "contents", 0, "text"))).toContain("/health")
    for (const log of ["config.log", "backend.log"]) {
      const entries = seen(root, log)
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) {
        expect(entry.script).toBe(PROJECT_CHILD)
        expect(entry.secret).toBe("from-dotenv")
      }
    }
  }, 60_000)

  test("started elsewhere: the project's .env still reaches its tools", async () => {
    const root = tempRoot()
    const elsewhere = tempRoot()
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", private: true }))
    writeFileSync(join(root, ".env"), "NIFRA_PROBE_SECRET=from-dotenv\n")
    writeApp(root)
    const { byId } = await mcpRpc(
      elsewhere,
      [root],
      [INITIALIZE, INITIALIZED, call(2, "whoami")],
      [1, 2],
    )
    const whoami: unknown = JSON.parse(toolText(byId[2]))
    expect(dig(whoami, "secret")).toBe("from-dotenv")
    expect(dig(whoami, "script")).toBe(PROJECT_CHILD)
  }, 60_000)

  test("a monorepo root: the server forgets the root's .env and keeps what its environment set", async () => {
    const root = tempRoot()
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mono", private: true }))
    writeFileSync(join(root, ".env"), "NIFRA_PROBE_SECRET=root-dotenv\n")
    writeFileSync(
      join(root, "nifra.config.ts"),
      `${record("./config.log")}export const apps = { web: "./apps/web" }\n`,
    )
    const web = join(root, "apps", "web")
    writeApp(web)
    const { byId } = await mcpRpc(
      root,
      [],
      [
        INITIALIZE,
        INITIALIZED,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        call(3, "web_whoami"),
      ],
      [1, 2, 3],
      { NIFRA_PROBE_SHELL: "from-shell" },
    )
    expect(toolNames(byId[2])).toContain("nifra_web_context")
    // apps/web has no .env: its subprocess sees only what the server passed on.
    const whoami: unknown = JSON.parse(toolText(byId[3]))
    expect(dig(whoami, "secret")).toBeNull()
    expect(dig(whoami, "shell")).toBe("from-shell")
    const logs: ReadonlyArray<readonly [string, string]> = [
      [root, "config.log"],
      [web, "config.log"],
      [web, "backend.log"],
    ]
    for (const [dir, log] of logs) {
      const entries = seen(dir, log)
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) expect(entry.script).toBe(PROJECT_CHILD)
    }
  }, 60_000)

  test("a config that exits takes down only its own process", async () => {
    const root = tempRoot()
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", private: true }))
    writeApp(root, "process.exit(7)\n")
    const { byId } = await mcpRpc(
      root,
      [],
      [
        INITIALIZE,
        INITIALIZED,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        call(3, "nifra_context"),
      ],
      [1, 2, 3],
    )
    expect(toolNames(byId[2])).toContain("nifra_context")
    expect(dig(byId[3], "result", "isError")).toBe(true)
  }, 60_000)
})

describe("forgetAutoLoadedEnv", () => {
  /** Run `forgetAutoLoadedEnv` in a fresh Bun process started in `dir` with `env`. */
  async function forgetIn(
    dir: string,
    env: Record<string, string>,
  ): Promise<{ removed: string[]; left: Record<string, string | null> }> {
    const script = join(dir, "forget.ts")
    writeFileSync(
      script,
      `import { forgetAutoLoadedEnv } from ${JSON.stringify(join(import.meta.dir, "../src/env-file.ts"))}\n` +
        "const removed = await forgetAutoLoadedEnv()\n" +
        'const names = ["A_FILE", "A_SHELL", "A_EXPANDED", "A_LOCAL", "NODE_ENV"]\n' +
        "console.log(JSON.stringify({ removed: [...removed].sort(), left: Object.fromEntries(names.map((n) => [n, process.env[n] ?? null])) }))\n",
    )
    const proc = Bun.spawn([process.execPath, script], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: "/home/probe", ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return JSON.parse(out)
  }

  test("removes what Bun loaded from .env files and keeps what the environment set", async () => {
    const dir = tempRoot()
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a .env expansion for Bun, written literally
    writeFileSync(join(dir, ".env"), "A_FILE=file\nA_SHELL=file\nA_EXPANDED=at-${HOME}\n")
    writeFileSync(join(dir, ".env.local"), "A_LOCAL=local\n")
    const { removed, left } = await forgetIn(dir, { A_SHELL: "shell", NODE_ENV: "development" })
    expect(removed).toEqual(["A_EXPANDED", "A_FILE", "A_LOCAL"])
    expect(left).toEqual({
      A_FILE: null,
      A_SHELL: "shell",
      A_EXPANDED: null,
      A_LOCAL: null,
      NODE_ENV: "development",
    })
  }, 30_000)

  test("does nothing in a directory without .env files", async () => {
    expect(await forgetAutoLoadedEnv(tempRoot())).toEqual([])
  })
})

describe("project subprocess", () => {
  test("a tool, a resource and a declared tool answer from a subprocess, kept until the backend changes", async () => {
    const root = tempRoot()
    writeApp(root)
    const surface = createAppSurface(root)
    const first = await surface()
    expect(await surface()).toBe(first)
    expect(first.tools.map((tool) => tool.name)).toEqual(["whoami"])
    const context = {
      signal: new AbortController().signal,
      requestId: 1,
      reportProgress: () => {},
    }
    const whoami = await first.tools[0]?.handler({}, context)
    expect(JSON.stringify(whoami)).not.toContain(`"pid":${process.pid}`)

    const [routes] = isolateTools(root, [
      { name: "nifra_routes", description: "", inputSchema: {}, handler: async () => "in-process" },
    ])
    expect(await routes?.handler({}, context)).not.toBe("in-process")
    const [kept] = isolateTools(root, [
      { name: "nifra_docs", description: "", inputSchema: {}, handler: async () => "in-process" },
    ])
    expect(await kept?.handler({}, context)).toBe("in-process")
    const [resource] = isolateResources(root, [
      { uri: "nifra://routes", name: "routes", read: async () => ({ text: "in-process" }) },
    ])
    expect((await resource?.read())?.text).toContain("/health")

    const loads = seen(root, "backend.log").length
    writeFileSync(join(root, "backend", "app.ts"), `${BACKEND}// edited\n`)
    const second = await surface()
    expect(second).not.toBe(first)
    expect(seen(root, "backend.log").length).toBe(loads + 1)
    for (const entry of seen(root, "backend.log")) expect(entry.script).toBe(PROJECT_CHILD)
  }, 60_000)

  test("a config that never finishes is killed at the deadline, and a cancelled call kills its process", async () => {
    const root = tempRoot()
    writeApp(
      root,
      `${record("./config.log")}await new Promise(() => setInterval(() => {}, 1_000))\n`,
    )
    expect(await askProjectChild(root, { op: "surface" }, { timeoutMs: 2_000 })).toEqual({
      ok: false,
      message: "[nifra] the project process did not answer within 2000ms and was killed",
    })
    const controller = new AbortController()
    const pending = askProjectChild(
      root,
      { op: "tool", name: "nifra_context", args: {} },
      {
        context: { signal: controller.signal, requestId: 2, reportProgress: () => {} },
      },
    )
    setTimeout(() => controller.abort(), 1_000)
    expect(await pending).toEqual({ ok: false, message: "[nifra] the call was cancelled" })
    for (const { pid } of seen(root, "config.log")) {
      expect(() => process.kill(pid, 0)).toThrow()
    }
  }, 30_000)

  test("monorepo detection reads the root's apps in a subprocess", async () => {
    const root = tempRoot()
    writeFileSync(
      join(root, "nifra.config.ts"),
      `${record("./config.log")}export const apps = { dash: "./apps/dash", bad: 1 }\n`,
    )
    expect(await detectMonorepoIsolated(root)).toEqual({ apps: { dash: "./apps/dash" } })
    for (const entry of seen(root, "config.log")) expect(entry.script).toBe(PROJECT_CHILD)

    const app = tempRoot()
    writeApp(app)
    expect(await detectMonorepoIsolated(app)).toBeNull()
    expect(seen(app, "config.log")).toEqual([])

    const throws = tempRoot()
    writeFileSync(join(throws, "nifra.config.ts"), 'throw new Error("boom")\n')
    expect(await detectMonorepoIsolated(throws)).toBeNull()
  }, 30_000)

  test("answers each request kind, and refuses a malformed one", async () => {
    const root = tempRoot()
    writeApp(root)
    expect(await answerProjectRequest(root, { op: "monorepo" })).toEqual({ ok: true, apps: null })
    expect(
      await answerProjectRequest(root, { op: "tool", name: "nifra_missing", args: {} }),
    ).toEqual({ ok: false, message: "unknown tool: nifra_missing" })
    expect(await answerProjectRequest(root, { op: "resource", uri: "nifra://none" })).toEqual({
      ok: false,
      message: "unknown resource: nifra://none",
    })
    expect(await answerProjectRequest(root, { op: "prompt", name: "none", args: {} })).toEqual({
      ok: false,
      message: "unknown prompt: none",
    })
    const resource = await answerProjectRequest(root, { op: "resource", uri: "nifra://routes" })
    expect(JSON.stringify(resource)).toContain("/health")

    const token = "0123456789abcdef0123"
    const lines: string[] = []
    const write = async (line: string): Promise<void> => {
      lines.push(line)
    }
    const stream = (text: string) => new Blob([text]).stream()
    expect(
      await serveProjectChild(root, stream(JSON.stringify({ token, op: "monorepo" })), write),
    ).toBe(true)
    expect(lines).toEqual([
      `${token} ${JSON.stringify({ type: "answer", answer: { ok: true, apps: null } })}\n`,
    ])
    for (const bad of [
      "not json",
      "[]",
      JSON.stringify({ token: "x", op: "monorepo" }),
      JSON.stringify({ token, op: "tool", name: "nifra_context" }),
      JSON.stringify({ token, op: "other" }),
    ]) {
      expect(await serveProjectChild(root, stream(bad), write)).toBe(false)
    }
    expect(lines).toHaveLength(1)
  }, 30_000)
})
