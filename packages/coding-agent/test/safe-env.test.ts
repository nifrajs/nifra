import { describe, expect, test } from "bun:test"
import { safeEnv } from "../src/internal/safe-env.ts"

/** Run `body` with `process.platform` reading `value`, restoring the original descriptor after. */
function onPlatform<T>(value: NodeJS.Platform, body: () => T): T {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value, configurable: true })
  try {
    return body()
  } finally {
    if (platform !== undefined) Object.defineProperty(process, "platform", platform)
  }
}

/** Run `body` with `vars` set in `process.env`, restoring each one after. */
function withEnv<T>(vars: Readonly<Record<string, string>>, body: () => T): T {
  const saved = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name])
    process.env[name] = value
  }
  try {
    return body()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

describe("safeEnv", () => {
  test("passes the allowlist through and nothing else", () => {
    withEnv({ CI: "1", NIFRA_SAFE_ENV_SECRET: "token" }, () => {
      const env = onPlatform("linux", () => safeEnv())
      expect(env.CI).toBe("1")
      expect(env.NIFRA_SAFE_ENV_SECRET).toBeUndefined()
      expect(env.SystemRoot).toBeUndefined()
    })
  })

  test("an override adds a name, replaces one, or removes one set to undefined", () => {
    withEnv({ CI: "1", TERM: "xterm" }, () => {
      const env = onPlatform("linux", () =>
        safeEnv({ GIT_PAGER: "cat", TERM: "dumb", CI: undefined }),
      )
      expect(env.GIT_PAGER).toBe("cat")
      expect(env.TERM).toBe("dumb")
      expect("CI" in env).toBe(false)
    })
  })

  test("on Windows it keeps the Windows names, matched in any casing", () => {
    withEnv({ systemroot: "C:\\Windows" }, () => {
      const env = onPlatform("win32", () => safeEnv())
      expect(env.SystemRoot).toBe("C:\\Windows")
    })
  })
})
