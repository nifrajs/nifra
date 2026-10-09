import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "../src/cli.ts"

describe("nifra-agent CLI arguments", () => {
  test("parses bounded RPC and session options", () => {
    const options = parseArgs([
      "--rpc",
      "--cwd",
      ".",
      "--host",
      "127.0.0.1",
      "--port",
      "7483",
      "--session-dir",
      ".sessions",
      "--token",
      "local-token-123456",
    ])
    expect(options.rpc).toBe(true)
    expect(options.port).toBe(7483)
    expect(options.host).toBe("127.0.0.1")
    expect(options.sessionDir).toContain(".sessions")
    expect(options.authToken).toBe("local-token-123456")
    expect(options.exposeErrorStacks).toBe(false)
  })

  test("parses the local RPC error-stack diagnostics flag", () => {
    expect(parseArgs(["--rpc", "--expose-error-stacks"]).exposeErrorStacks).toBe(true)
  })

  test("parses the bounded automatic repair limit", () => {
    expect(parseArgs(["--max-repair-attempts", "3"]).maxRepairAttempts).toBe(3)
    expect(() => parseArgs(["--max-repair-attempts", "9"])).toThrow("max-repair-attempts")
  })

  test("parses optional post-turn verification gates", () => {
    expect(parseArgs(["--verify-after-turn", "check,assure,check"]).verifyAfterTurn).toEqual([
      "check",
      "assure",
    ])
    expect(() => parseArgs(["--verify-after-turn", "deploy"])).toThrow("verify-after-turn")
  })

  test("requires a replay file for deterministic replay mode", () => {
    expect(parseArgs(["--backend", "replay", "--replay", "events.jsonl"]).replayFile).toContain(
      "events.jsonl",
    )
    expect(() => parseArgs(["--backend", "replay"])).toThrow("requires --replay")
  })
})

describe("project extensions load only on request", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

  async function runIn(cwd: string, extra: readonly string[]): Promise<void> {
    const events = join(cwd, "events.jsonl")
    await Bun.write(events, "")
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        "--backend",
        "replay",
        "--replay",
        events,
        "--once",
        "hi",
        "--no-session",
        "--cwd",
        cwd,
        ...extra,
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    expect(await child.exited).toBe(0)
  }

  test("a cloned repository's .nifra/extensions never runs without --extensions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nifra-agent-ext-"))
    try {
      mkdirSync(join(cwd, ".nifra/extensions"), { recursive: true })
      await Bun.write(
        join(cwd, ".nifra/extensions/evil.ts"),
        'import { writeFileSync } from "node:fs"\nwriteFileSync(import.meta.dir + "/../../RAN", "x")\nexport default () => {}\n',
      )
      await runIn(cwd, [])
      expect(existsSync(join(cwd, "RAN"))).toBe(false)
      await runIn(cwd, ["--extensions"])
      expect(existsSync(join(cwd, "RAN"))).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// Asks for one confirmation per prompt and ends the turn once it is answered.
const APPROVING_PI = `
let buffered = ""
for await (const chunk of process.stdin) {
  buffered += chunk
  for (let i = buffered.indexOf("\\n"); i >= 0; i = buffered.indexOf("\\n")) {
    const line = buffered.slice(0, i)
    buffered = buffered.slice(i + 1)
    if (line.length === 0) continue
    const message = JSON.parse(line)
    if (message.type === "prompt")
      console.log(JSON.stringify({ type: "extension_ui_request", id: "appr-1", method: "confirm", title: "run thing" }))
    if (message.type === "extension_ui_response") console.log(JSON.stringify({ type: "agent_end" }))
  }
}
`

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffered = ""
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true })
    for (let i = buffered.indexOf("\n"); i >= 0; i = buffered.indexOf("\n")) {
      const line = buffered.slice(0, i)
      buffered = buffered.slice(i + 1)
      if (line.length > 0) yield line
    }
  }
}

describe("the interactive CLI during a turn", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

  // The Pi stand-in is a shell wrapper, which Windows cannot exec.
  test.skipIf(process.platform === "win32")(
    "an /approve typed while the turn waits on it reaches Pi and the turn completes",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "nifra-agent-approve-"))
      try {
        writeFileSync(join(cwd, "pi.ts"), APPROVING_PI)
        const pi = join(cwd, "pi")
        writeFileSync(pi, `#!/bin/sh\nexec "${process.execPath}" "${join(cwd, "pi.ts")}" "$@"\n`, {
          mode: 0o755,
        })
        const child = Bun.spawn(
          [process.execPath, cli, "--pi", pi, "--cwd", cwd, "--json", "--no-session"],
          { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
        )
        child.stdin.write("please do it\n")
        child.stdin.flush()
        const types: unknown[] = []
        for await (const line of lines(child.stdout)) {
          const event: { readonly type?: unknown; readonly approvalId?: unknown } = JSON.parse(line)
          types.push(event.type)
          if (event.type === "approval.required") {
            child.stdin.write(`/approve ${String(event.approvalId)}\n`)
            child.stdin.flush()
          }
          if (event.type === "session.completed") child.stdin.end()
        }
        expect(await child.exited).toBe(0)
        expect(types.slice(1)).toEqual([
          "turn.started",
          "approval.required",
          "approval.resolved",
          "session.updated",
          "session.completed",
        ])
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    },
  )
})
