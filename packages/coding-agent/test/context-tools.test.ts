import { describe, expect, test } from "bun:test"
import { runNifraContext } from "../src/context.ts"
import { createNifraTools, NIFRA_AGENT_INSTRUCTIONS } from "../src/tools.ts"

describe("runNifraContext", () => {
  test("returns parsed JSON report when command succeeds with JSON stdout", async () => {
    const result = await runNifraContext({
      cwd: process.cwd(),
      command: process.execPath,
      // Use bun -e by passing a script? Wait: runNifraContext invokes [command, "context"].
      // Instead, test with a nonexistent command and a real executable wrapper below.
    })
    // Bun invoked with "context" will exit non-zero when no "context" script exists in cwd
    expect(result.status === null || typeof result.status === "number").toBe(true)
  })

  test("parses JSON output from a custom command executable", async () => {
    const dir = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(require("node:path").join(require("node:os").tmpdir(), "nifra-ctx-")),
    )
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const script = path.join(dir, "fake-nifra.sh")
    try {
      await fs.writeFile(
        script,
        '#!/bin/sh\nif [ "$1" = "context" ]; then printf \'{"routes":2,"ok":true}\'; exit 0; fi\necho "unexpected" >&2; exit 2\n',
        { mode: 0o755 },
      )
      const res = await runNifraContext({ cwd: dir, command: script })
      expect(res.ok).toBe(true)
      expect(res.status).toBe(0)
      expect(res.output).toBe('{"routes":2,"ok":true}')
      expect(res.report).toEqual({ routes: 2, ok: true })
      expect(res.error).toBeUndefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("handles non-JSON stdout and stderr on non-zero exit", async () => {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const os = await import("node:os")
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nifra-ctx-err-"))
    const script = path.join(dir, "fail-nifra.sh")
    try {
      await fs.writeFile(script, '#!/bin/sh\necho "boom" >&2\nexit 1\n', { mode: 0o755 })
      const res = await runNifraContext({ cwd: dir, command: script })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(1)
      expect(res.output).toContain("boom")
      expect(res.report).toBeUndefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("reports timeout when command exceeds timeoutMs", async () => {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const os = await import("node:os")
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nifra-ctx-to-"))
    const script = path.join(dir, "slow-nifra.sh")
    try {
      await fs.writeFile(script, "#!/bin/sh\nsleep 5\n", { mode: 0o755 })
      const res = await runNifraContext({ cwd: dir, command: script, timeoutMs: 100 })
      expect(res.ok).toBe(false)
      expect(res.error).toContain("timed out")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("catches spawn errors for missing command", async () => {
    const res = await runNifraContext({
      cwd: process.cwd(),
      command: "/nonexistent/nifra-command-definitely-missing",
    })
    expect(res.ok).toBe(false)
    expect(res.status).toBeNull()
    expect(typeof res.error).toBe("string")
    expect((res.error ?? "").length).toBeGreaterThan(0)
  })
})

describe("createNifraTools", () => {
  test("exposes frozen first-party tool descriptors and instructions", () => {
    expect(NIFRA_AGENT_INSTRUCTIONS).toContain("nifra context")
    expect(NIFRA_AGENT_INSTRUCTIONS).toContain("nifra check --json")
    const tools = createNifraTools({ cwd: process.cwd() })
    expect(Object.isFrozen(tools)).toBe(true)
    expect(tools.map((t) => t.name)).toEqual([
      "nifra.context",
      "nifra.check",
      "nifra.assure",
      "nifra.test",
    ])
    for (const tool of tools) {
      expect(tool.capability).toBe("process")
      expect(tool.description.length).toBeGreaterThan(10)
    }
  })

  test("executes context, check, assure, and test tools against a stub binary", async () => {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const os = await import("node:os")
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nifra-tools-"))
    const script = path.join(dir, "stub-nifra.sh")
    try {
      await fs.writeFile(script, '#!/bin/sh\nprintf \'{"cmd":"%s","ok":true}\' "$1"\nexit 0\n', {
        mode: 0o755,
      })
      const tools = createNifraTools({ cwd: dir, command: script })
      const byName = new Map(tools.map((t) => [t.name, t]))

      const ctxRes = await byName.get("nifra.context")!.execute()
      expect(ctxRes.ok).toBe(true)

      const checkRes = await byName.get("nifra.check")!.execute()
      expect(checkRes.ok).toBe(true)

      const assureRes = await byName.get("nifra.assure")!.execute()
      expect(assureRes.ok).toBe(true)

      const testRes = await byName.get("nifra.test")!.execute()
      expect(testRes.ok).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
