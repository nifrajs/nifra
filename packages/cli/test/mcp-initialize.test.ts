import { afterAll, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

const root = createFixtureRoot("mcp-initialize-")
afterAll(() => removeFixtureRoot(root))

// The backend's import does not finish until the test opens the gate, like one awaiting a database
// connection at module scope.
writeAppFile(
  root,
  "package.json",
  JSON.stringify({ name: "slow-import", type: "module", dependencies: { "@nifrajs/core": "*" } }),
)
writeAppFile(
  root,
  "backend/app.ts",
  [
    'import { existsSync, watch } from "node:fs"',
    'import { server } from "@nifrajs/core"',
    `const gate = ${JSON.stringify(join(root, "gate"))}`,
    "await new Promise<void>((done) => {",
    `  const watcher = watch(${JSON.stringify(root)}, () => {`,
    "    if (!existsSync(gate)) return",
    "    watcher.close()",
    "    done()",
    "  })",
    "  if (existsSync(gate)) {",
    "    watcher.close()",
    "    done()",
    "  }",
    "})",
    'export const backend = server().get("/x", () => "x")',
    "",
  ].join("\n"),
)

/** A `nifra mcp` session over stdio: `send` a message, await the `answer` to an id. */
function session(cwd: string) {
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "mcp"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  const answers = new Map<number, PromiseWithResolvers<unknown>>()
  const entry = (id: number): PromiseWithResolvers<unknown> => {
    let found = answers.get(id)
    if (found === undefined) {
      found = Promise.withResolvers<unknown>()
      answers.set(id, found)
    }
    return found
  }
  const pumped = (async () => {
    const decoder = new TextDecoder()
    let buffered = ""
    for await (const chunk of proc.stdout) {
      buffered += decoder.decode(chunk, { stream: true })
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("{")) continue
        const parsed: unknown = JSON.parse(line)
        const id = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "id") : null
        if (typeof id === "number") entry(id).resolve(parsed)
      }
    }
  })()
  return {
    send(message: object): void {
      proc.stdin.write(`${JSON.stringify(message)}\n`)
      proc.stdin.flush()
    },
    answer: (id: number): Promise<unknown> => entry(id).promise,
    async close(): Promise<void> {
      proc.kill()
      await proc.exited
      await pumped.catch(() => {})
    },
  }
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

test("initialize is answered while the app is still importing", async () => {
  const live = session(root)
  try {
    live.send(initialize)
    expect(await live.answer(1)).toHaveProperty("result.serverInfo.name", "nifra")
    live.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    live.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    writeFileSync(join(root, "gate"), "")
    expect(await live.answer(2)).toHaveProperty("result.tools")
  } finally {
    writeFileSync(join(root, "gate"), "")
    await live.close()
  }
}, 20_000)

// Each app's import waits for the other's to start, so apps loaded one after another never finish.
const mono = createFixtureRoot("mcp-initialize-mono-")
afterAll(() => removeFixtureRoot(mono))
writeAppFile(mono, "package.json", JSON.stringify({ name: "mono", private: true }))
writeAppFile(mono, "nifra.config.ts", 'export const apps = { a: "./apps/a", b: "./apps/b" }\n')
for (const [name, other] of [
  ["a", "b"],
  ["b", "a"],
] as const) {
  const app = join(mono, "apps", name)
  writeAppFile(
    app,
    "package.json",
    JSON.stringify({ name, type: "module", dependencies: { "@nifrajs/core": "*" } }),
  )
  writeAppFile(
    app,
    "backend/app.ts",
    [
      'import { existsSync, watch, writeFileSync } from "node:fs"',
      'import { server } from "@nifrajs/core"',
      `writeFileSync(${JSON.stringify(join(mono, `${name}.started`))}, "")`,
      `const other = ${JSON.stringify(join(mono, `${other}.started`))}`,
      "await new Promise<void>((done) => {",
      `  const watcher = watch(${JSON.stringify(mono)}, () => {`,
      "    if (!existsSync(other)) return",
      "    watcher.close()",
      "    done()",
      "  })",
      "  if (existsSync(other)) {",
      "    watcher.close()",
      "    done()",
      "  }",
      "})",
      `export const backend = server().get("/${name}", () => "${name}")`,
      "",
    ].join("\n"),
  )
}

test("a monorepo's apps load side by side, not one after another", async () => {
  const live = session(mono)
  try {
    live.send(initialize)
    live.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const listed = await live.answer(2)
    const tools =
      typeof listed === "object" && listed !== null ? Reflect.get(listed, "result") : null
    const names = JSON.stringify(tools)
    expect(names).toContain("nifra_a_")
    expect(names).toContain("nifra_b_")
  } finally {
    await live.close()
  }
}, 20_000)
