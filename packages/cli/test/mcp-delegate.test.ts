import { afterAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name, version: PROJECT_VERSION }))
  }
  if (over.bin === true) {
    // The project's CLI, reduced to what the hand-off contract needs: it answers the first request
    // with the argv, cwd and hand-off marker it was started with.
    const bin = join(dir, "node_modules", ".bin", "nifra")
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true })
    await writeFile(
      bin,
      [
        "#!/bin/sh",
        "read line",
        `printf '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"project-cli","version":"${PROJECT_VERSION}"},"args":"%s","marker":"%s","cwd":"%s"}}\\n' "$*" "$${MCP_DELEGATED_ENV}" "$(pwd -P)"`,
        "",
      ].join("\n"),
    )
    await chmod(bin, 0o755)
  }
  return dir
}

/** Drive `nifra mcp` over stdio until every expected id answered (or the process exits). */
const rpc = async (
  cwd: string,
  args: readonly string[],
  messages: readonly object[],
  ids: readonly number[],
  env: Readonly<Record<string, string>> = {},
): Promise<Record<number, Record<string, unknown>>> => {
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
  for (const message of messages) stdin.write(`${JSON.stringify(message)}\n`)
  const byId: Record<number, Record<string, unknown>> = {}
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  const deadline = Date.now() + 40_000
  try {
    while (ids.some((id) => byId[id] === undefined) && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), 40_000),
        ),
      ])
      if (chunk.done) break
      buffered += decoder.decode(chunk.value, { stream: true })
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("{")) continue
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (typeof parsed.id === "number") byId[parsed.id] = parsed
      }
    }
  } finally {
    reader.cancel().catch(() => {})
    proc.kill()
    await proc.exited.catch(() => 0)
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
      cwd: dir,
    })
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
        call(7, "nifra_learn"),
      ],
      [1, 2, 3, 4, 5, 6, 7],
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
    ] as const) {
      expect(isErrorOf(answered[id])).toBe(true)
      const text = textOf(answered[id])
      expect(text).toContain(`${tool} refused`)
      expect(text).toContain(`@nifrajs/core ${PROJECT_VERSION}`)
      expect(text).toContain(`bun add -d @nifrajs/cli@${PROJECT_VERSION}`)
    }
    // A release-independent tool still answers.
    expect(isErrorOf(answered[7])).not.toBe(true)
    expect(textOf(answered[7])).not.toContain("refused")
  }, 45_000)

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

  test("a project CLI without a linked bin cannot take the session, so the tools refuse", async () => {
    const dir = await project("no-bin", { cli: true })
    expect(await findProjectCli(dir)).toEqual({ version: PROJECT_VERSION })
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
