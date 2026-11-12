import { afterAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  findProjectCli,
  MCP_DELEGATED_ENV,
  refuseVersionSensitive,
  VERSION_SENSITIVE_TOOLS,
} from "../src/mcp-delegate.ts"
import type { McpTool } from "../src/mcp-protocol.ts"

// A client spawns this checkout's CLI (standing in for a global install) against a project pinned to
// another nifra release. The server must either hand the session to the project's CLI or refuse the
// version-sensitive tools - never answer for the wrong release.

const PROJECT_VERSION = "9.9.0"
const grounds: string[] = []

afterAll(async () => {
  await Promise.all(grounds.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** The project's CLI, reduced to what the hand-off contract needs: it answers the first request
 * with the argv, cwd, hand-off marker and `.env` secret it was started with. */
const FAKE_CLI_SOURCE = `#!/usr/bin/env bun
import { realpathSync } from "node:fs"
const reader = Bun.stdin.stream().getReader()
let text = ""
while (!text.includes("\\n")) {
  const { value, done } = await reader.read()
  if (done) break
  text += new TextDecoder().decode(value)
}
const result = {
  serverInfo: { name: "project-cli", version: ${JSON.stringify(PROJECT_VERSION)} },
  args: process.argv.slice(2).join(" "),
  marker: process.env[${JSON.stringify(MCP_DELEGATED_ENV)}] ?? "",
  secret: process.env.NIFRA_DELEGATE_SECRET ?? "",
  cwd: realpathSync.native(process.cwd()),
}
process.stdout.write(\`\${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\\n\`)
`

/** A project CLI that answers every request with the method it was asked, and what it started with. */
const RELAY_CLI_SOURCE = `#!/usr/bin/env bun
const decoder = new TextDecoder()
let buffered = ""
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true })
  for (let at = buffered.indexOf("\\n"); at !== -1; at = buffered.indexOf("\\n")) {
    const line = buffered.slice(0, at).trim()
    buffered = buffered.slice(at + 1)
    if (line === "") continue
    const message = JSON.parse(line)
    if (message.id === undefined) continue
    const result = {
      from: "project-cli",
      method: message.method,
      marker: process.env[${JSON.stringify(MCP_DELEGATED_ENV)}] ?? "",
      args: process.argv.slice(2).join(" "),
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n")
  }
}
`

/** A nifra project whose install pins `@nifrajs/*` to {@link PROJECT_VERSION}. */
const project = async (
  label: string,
  over: { readonly cli?: boolean; readonly bin?: boolean } = {},
): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `nifra-mcp-delegate-${label}-`)))
  grounds.push(dir)
  const deps: Record<string, string> = { "@nifrajs/core": PROJECT_VERSION }
  if (over.cli === true) deps["@nifrajs/cli"] = PROJECT_VERSION
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: deps }))
  for (const name of Object.keys(deps)) {
    const pkg = join(dir, "node_modules", ...name.split("/"))
    await mkdir(pkg, { recursive: true })
    const bin =
      name === "@nifrajs/cli" && over.bin === true ? { bin: { nifra: "dist/cli.js" } } : {}
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name, version: PROJECT_VERSION, ...bin }),
    )
  }
  if (over.bin === true) {
    const script = join(dir, "node_modules", "@nifrajs", "cli", "dist", "cli.js")
    await mkdir(dirname(script), { recursive: true })
    await writeFile(script, FAKE_CLI_SOURCE)
    await chmod(script, 0o755)
    // Linked as an install links it; a client launching this shim gets Bun's `.env` loading.
    if (process.platform !== "win32") {
      await mkdir(join(dir, "node_modules", ".bin"), { recursive: true })
      await symlink("../@nifrajs/cli/dist/cli.js", join(dir, "node_modules", ".bin", "nifra"))
    }
  }
  return dir
}

/** A live `nifra mcp` session over stdio: send messages, then await the answer to an id. */
const session = (
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
) => {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env }
  if (env[MCP_DELEGATED_ENV] === undefined) delete childEnv[MCP_DELEGATED_ENV]
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), "mcp", ...args],
    {
      cwd,
      env: childEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  )
  const stdin = proc.stdin as { write(s: string): unknown }
  const byId: Record<number, Record<string, unknown>> = {}
  const received: Record<string, unknown>[] = []
  const waiters = new Map<number, () => void>()
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const pumped = (async () => {
    const decoder = new TextDecoder()
    let buffered = ""
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffered += decoder.decode(chunk.value, { stream: true })
        const lines = buffered.split("\n")
        buffered = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("{")) continue
          const parsed = JSON.parse(line) as Record<string, unknown>
          received.push(parsed)
          if (typeof parsed.id !== "number") continue
          byId[parsed.id] = parsed
          waiters.get(parsed.id)?.()
        }
      }
    } catch {
      // The process was killed mid-read: every pending answer stays undefined.
    }
  })()
  return {
    received,
    send(message: object): void {
      stdin.write(`${JSON.stringify(message)}\n`)
    },
    async answer(id: number): Promise<Record<string, unknown> | undefined> {
      if (byId[id] === undefined) {
        const arrived = new Promise<void>((resolve) => waiters.set(id, resolve))
        await Promise.race([arrived, pumped, Bun.sleep(40_000)])
      }
      return byId[id]
    },
    async close(): Promise<void> {
      reader.cancel().catch(() => {})
      proc.kill()
      await proc.exited.catch(() => 0)
    },
  }
}

/** Drive `nifra mcp` over stdio until every expected id answered (or the process exits). */
const rpc = async (
  cwd: string,
  args: readonly string[],
  messages: readonly object[],
  ids: readonly number[],
  env: Readonly<Record<string, string>> = {},
): Promise<Record<number, Record<string, unknown>>> => {
  const live = session(cwd, args, env)
  for (const message of messages) live.send(message)
  const byId: Record<number, Record<string, unknown>> = {}
  try {
    for (const id of ids) {
      const answer = await live.answer(id)
      if (answer !== undefined) byId[id] = answer
    }
  } finally {
    await live.close()
  }
  return byId
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
}
const call = (id: number, name: string, args: object = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
})

const textOf = (response: Record<string, unknown> | undefined): string =>
  ((response?.result as { content?: { text?: string }[] } | undefined)?.content ?? [])
    .map((block) => block.text ?? "")
    .join("\n")

const isErrorOf = (response: Record<string, unknown> | undefined): unknown =>
  (response?.result as { isError?: unknown } | undefined)?.isError

describe("nifra mcp against a project on another nifra release", () => {
  test("hands the session to the project's own CLI, marked so it never hands off again", async () => {
    const dir = await project("handoff", { cli: true, bin: true })
    const answered = await rpc(dir, [], [initialize], [1])
    expect(answered[1]?.result).toEqual({
      serverInfo: { name: "project-cli", version: PROJECT_VERSION },
      args: "mcp",
      marker: "1",
      secret: "",
      cwd: dir,
    })
  }, 45_000)

  test("the project's CLI gets none of the project's .env values", async () => {
    const dir = await project("handoff-env", { cli: true, bin: true })
    await writeFile(join(dir, ".env"), "NIFRA_DELEGATE_SECRET=hunter2\n")
    const answered = await rpc(dir, [], [initialize], [1])
    expect(answered[1]).toHaveProperty("result.serverInfo.name", "project-cli")
    expect(answered[1]).toHaveProperty("result.secret", "")
  }, 45_000)

  test("an explicit project dir is passed through to the project's CLI", async () => {
    const dir = await project("handoff-dir", { cli: true, bin: true })
    const answered = await rpc(tmpdir(), [dir], [initialize], [1])
    expect((answered[1]?.result as { args?: unknown } | undefined)?.args).toBe(`mcp ${dir}`)
  }, 45_000)

  test("with no project CLI to hand off to, version-sensitive tools refuse with the fix", async () => {
    const dir = await project("refuse")
    const answered = await rpc(
      dir,
      [],
      [
        initialize,
        call(2, "nifra_check"),
        call(3, "nifra_types", { query: "server" }),
        call(4, "nifra_docs", { query: "routing" }),
        call(5, "nifra_assure"),
        call(6, "nifra_contracts"),
        call(7, "nifra_example", { query: "upload" }),
        call(8, "nifra_learn"),
      ],
      [1, 2, 3, 4, 5, 6, 7, 8],
    )
    expect((answered[1]?.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe(
      "nifra",
    )
    for (const [id, tool] of [
      [2, "nifra_check"],
      [3, "nifra_types"],
      [4, "nifra_docs"],
      [5, "nifra_assure"],
      [6, "nifra_contracts"],
      [7, "nifra_example"],
    ] as const) {
      expect(isErrorOf(answered[id])).toBe(true)
      const text = textOf(answered[id])
      expect(text).toContain(`${tool} refused`)
      expect(text).toContain(`@nifrajs/core ${PROJECT_VERSION}`)
      expect(text).toContain(`bun add -d @nifrajs/cli@${PROJECT_VERSION}`)
    }
    // A release-independent tool still answers.
    expect(isErrorOf(answered[8])).not.toBe(true)
    expect(textOf(answered[8])).not.toContain("refused")
  }, 45_000)

  test("a CLI the project installs mid-session takes over the rest of it", async () => {
    const dir = await project("mid-session")
    const live = session(dir, [])
    try {
      live.send(initialize)
      live.send({ jsonrpc: "2.0", method: "notifications/initialized" })
      expect(await live.answer(1)).toHaveProperty("result.serverInfo.name", "nifra")

      const cli = join(dir, "node_modules", "@nifrajs", "cli")
      await mkdir(join(cli, "dist"), { recursive: true })
      await writeFile(
        join(cli, "package.json"),
        JSON.stringify({
          name: "@nifrajs/cli",
          version: PROJECT_VERSION,
          bin: { nifra: "./dist/cli.js" },
        }),
      )
      await writeFile(join(cli, "dist", "cli.js"), RELAY_CLI_SOURCE)

      live.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
      live.send(call(3, "nifra_docs", { query: "routing" }))
      expect((await live.answer(2))?.result).toEqual({
        from: "project-cli",
        method: "tools/list",
        marker: "1",
        args: "mcp",
      })
      expect((await live.answer(3))?.result).toHaveProperty("method", "tools/call")
      // The replayed handshake answers nobody, and the client is told its list changed.
      expect(live.received.filter((message) => message.id === "nifra-relay-handshake")).toEqual([])
      expect(live.received.some((m) => m.method === "notifications/tools/list_changed")).toBe(true)
    } finally {
      await live.close()
    }
  }, 60_000)

  test("a project CLI that never answers the handshake leaves the session where it was", async () => {
    const dir = await project("mid-session-mute")
    const live = session(dir, [])
    try {
      live.send(initialize)
      await live.answer(1)
      const cli = join(dir, "node_modules", "@nifrajs", "cli")
      await mkdir(join(cli, "dist"), { recursive: true })
      await writeFile(
        join(cli, "package.json"),
        JSON.stringify({
          name: "@nifrajs/cli",
          version: PROJECT_VERSION,
          bin: { nifra: "./dist/cli.js" },
        }),
      )
      await writeFile(join(cli, "dist", "cli.js"), "process.exit(3)\n")
      live.send(call(2, "nifra_learn"))
      const answer = await live.answer(2)
      expect(textOf(answer)).not.toContain("project-cli")
      expect(isErrorOf(answer)).not.toBe(true)
      expect(live.received.some((m) => m.method === "notifications/tools/list_changed")).toBe(false)
    } finally {
      await live.close()
    }
  }, 60_000)

  test("an already handed-off server that still disagrees refuses instead of handing off again", async () => {
    const dir = await project("loop-guard", { cli: true, bin: true })
    const answered = await rpc(dir, [], [initialize, call(2, "nifra_check")], [1, 2], {
      [MCP_DELEGATED_ENV]: "1",
    })
    expect((answered[1]?.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe(
      "nifra",
    )
    expect(isErrorOf(answered[2])).toBe(true)
    const text = textOf(answered[2])
    expect(text).toContain(`@nifrajs/cli ${PROJECT_VERSION}`)
    expect(text).toContain("./node_modules/.bin/nifra mcp")
  }, 45_000)

  test("an install during the session is seen on the next call, so the tools refuse from then on", async () => {
    const dir = await project("mid-session")
    const core = join(dir, "node_modules", "@nifrajs", "core", "package.json")
    const own: { version: string } = await Bun.file(
      join(import.meta.dir, "..", "package.json"),
    ).json()
    await writeFile(core, JSON.stringify({ name: "@nifrajs/core", version: own.version }))
    const live = session(dir, [])
    try {
      live.send(initialize)
      live.send(call(2, "nifra_docs", { query: "routing" }))
      expect(textOf(await live.answer(2))).not.toContain("refused")
      await writeFile(core, JSON.stringify({ name: "@nifrajs/core", version: PROJECT_VERSION }))
      live.send(call(3, "nifra_docs", { query: "routing" }))
      const after = await live.answer(3)
      expect(isErrorOf(after)).toBe(true)
      expect(textOf(after)).toContain(`nifra_docs refused`)
      expect(textOf(after)).toContain(`@nifrajs/core ${PROJECT_VERSION}`)
    } finally {
      await live.close()
    }
  }, 45_000)

  test("a project CLI without a linked bin cannot take the session, so the tools refuse", async () => {
    const dir = await project("no-bin", { cli: true })
    expect(await findProjectCli(dir)).toEqual({
      version: PROJECT_VERSION,
      dir: join(dir, "node_modules", "@nifrajs", "cli"),
    })
    const answered = await rpc(dir, [], [initialize, call(2, "nifra_docs", { query: "x" })], [1, 2])
    expect(isErrorOf(answered[2])).toBe(true)
    expect(textOf(answered[2])).toContain("nifra_docs refused")
  }, 45_000)
})

test("refuseVersionSensitive leaves every tool alone without drift and only the listed ones with it", async () => {
  const tool = (name: string): McpTool => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    handler: async () => `${name} answered`,
  })
  const tools = [...VERSION_SENSITIVE_TOOLS, "nifra_run"].map(tool)
  expect(refuseVersionSensitive(tools, undefined)).toBe(tools)
  const drift = { cli: "3.5.0", project: PROJECT_VERSION, package: "@nifrajs/core" }
  const context = {} as Parameters<McpTool["handler"]>[1]
  for (const guarded of refuseVersionSensitive(tools, drift)) {
    const result = await guarded.handler({}, context)
    if (guarded.name === "nifra_run") expect(result).toBe("nifra_run answered")
    else expect(result).toMatchObject({ isError: true })
  }
})
