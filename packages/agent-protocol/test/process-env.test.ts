import { describe, expect, test } from "bun:test"
import { childProcessBaseEnv, childProcessEnv } from "../src/process-env.ts"

describe("child process environment", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    TERM: "xterm",
    SystemRoot: "C:\\Windows",
    USERPROFILE: "C:\\Users\\dev",
    OPENAI_API_KEY: "sk-host",
    AWS_SECRET_ACCESS_KEY: "aws-host",
  }

  test("POSIX passes the base set and nothing else from the host", () => {
    expect(childProcessEnv({ env: host, platform: "linux" })).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      TERM: "xterm",
    })
  })

  test("Windows adds the system and profile variables a process needs to start", () => {
    expect(childProcessEnv({ env: host, platform: "win32" })).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      TERM: "xterm",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\dev",
    })
    expect(childProcessBaseEnv("win32")).toContain("ProgramFiles(x86)")
    expect(childProcessBaseEnv("darwin")).not.toContain("SystemRoot")
  })

  test("names are read from the host, values win, and an undefined value drops the name", () => {
    expect(
      childProcessEnv({
        env: host,
        platform: "linux",
        names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
        values: { HOME: "/sandbox", PATH: undefined, MODEL: "small" },
      }),
    ).toEqual({ HOME: "/sandbox", TERM: "xterm", OPENAI_API_KEY: "sk-host", MODEL: "small" })
  })
})
