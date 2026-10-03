import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  const cli = new URL("../src/cli.ts", import.meta.url).pathname

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
