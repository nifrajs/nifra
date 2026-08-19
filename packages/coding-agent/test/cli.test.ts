import { describe, expect, test } from "bun:test"
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
