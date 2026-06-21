import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type InitAgentsResult,
  initAgents,
  renderInitAgents,
  runInitAgents,
  safeJoin,
} from "../src/init-agents.ts"

const roots: string[] = []
async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nifra-init-agents-"))
  roots.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

const read = (dir: string, rel: string): Promise<string> => readFile(join(dir, rel), "utf8")
const actionFor = (r: InitAgentsResult, path: string): string | undefined =>
  r.files.find((f) => f.path === path)?.action

describe("safeJoin — confines writes to the project root", () => {
  test("resolves a normal relative path under cwd", () => {
    expect(safeJoin("/proj", ".cursor/mcp.json")).toBe("/proj/.cursor/mcp.json")
    expect(safeJoin("/proj", "CLAUDE.md")).toBe("/proj/CLAUDE.md")
  })

  test("rejects a path that escapes the root (traversal)", () => {
    expect(() => safeJoin("/proj", "../evil")).toThrow(/outside the project root/)
    expect(() => safeJoin("/proj", "../../etc/passwd")).toThrow(/outside the project root/)
  })

  test("rejects an absolute escape", () => {
    expect(() => safeJoin("/proj", "/etc/passwd")).toThrow(/outside the project root/)
  })
})

describe("initAgents — fresh project", () => {
  test("writes all four agent-discovery files", async () => {
    const dir = await freshDir()
    const result = await initAgents(dir)

    // .mcp.json — Claude Code's exact shape, registering the bin-owning package.
    const mcp = JSON.parse(await read(dir, ".mcp.json")) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(mcp.mcpServers.nifra).toEqual({ command: "bunx", args: ["@nifrajs/cli", "mcp"] })

    // .cursor/mcp.json — same server config, byte-identical (single source of truth).
    expect(await read(dir, ".cursor/mcp.json")).toBe(await read(dir, ".mcp.json"))

    // CLAUDE.md — MCP-first preamble that imports AGENTS.md on its own line (no drift).
    const claude = await read(dir, "CLAUDE.md")
    expect(claude).toContain("nifra MCP server")
    expect(claude).toContain("nifra_check")
    expect(claude.split("\n")).toContain("@AGENTS.md")

    // AGENTS.md — written fresh (none existed) with the MCP section.
    const agents = await read(dir, "AGENTS.md")
    expect(agents).toContain("## MCP server")
    expect(agents).toContain("bunx @nifrajs/cli mcp")

    expect(result.files.map((f) => f.action)).toEqual(["wrote", "wrote", "wrote", "wrote"])
  })
})

describe("initAgents — no-clobber + idempotency", () => {
  test("a second run skips the owned files and keeps an AGENTS.md that already has the section", async () => {
    const dir = await freshDir()
    await initAgents(dir)
    const before = await read(dir, "CLAUDE.md")

    const second = await initAgents(dir)
    expect(actionFor(second, ".mcp.json")).toBe("skipped")
    expect(actionFor(second, ".cursor/mcp.json")).toBe("skipped")
    expect(actionFor(second, "CLAUDE.md")).toBe("skipped")
    expect(actionFor(second, "AGENTS.md")).toBe("present")
    expect(await read(dir, "CLAUDE.md")).toBe(before) // untouched
  })

  test("a customized CLAUDE.md is preserved (not clobbered) without --force", async () => {
    const dir = await freshDir()
    const custom = "# My CLAUDE\n\nHand-written project rules.\n"
    await writeFile(join(dir, "CLAUDE.md"), custom)

    const result = await initAgents(dir)
    expect(actionFor(result, "CLAUDE.md")).toBe("skipped")
    expect(await read(dir, "CLAUDE.md")).toBe(custom)
    // The other files still land — only the existing one is spared.
    expect(actionFor(result, ".mcp.json")).toBe("wrote")
  })

  test("an existing customized .mcp.json is preserved without --force", async () => {
    const dir = await freshDir()
    const custom = `${JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }, null, 2)}\n`
    await writeFile(join(dir, ".mcp.json"), custom)

    const result = await initAgents(dir)
    expect(actionFor(result, ".mcp.json")).toBe("skipped")
    expect(await read(dir, ".mcp.json")).toBe(custom)
  })
})

describe("initAgents — --force", () => {
  test("overwrites the owned files", async () => {
    const dir = await freshDir()
    await writeFile(join(dir, "CLAUDE.md"), "# stale\n")
    await writeFile(join(dir, ".mcp.json"), "{}\n")

    const result = await initAgents(dir, { force: true })
    expect(actionFor(result, "CLAUDE.md")).toBe("wrote")
    expect(actionFor(result, ".mcp.json")).toBe("wrote")
    expect(await read(dir, "CLAUDE.md")).toContain("nifra MCP server")
    const mcp = JSON.parse(await read(dir, ".mcp.json")) as {
      mcpServers: Record<string, unknown>
    }
    expect(mcp.mcpServers.nifra).toBeDefined()
  })
})

describe("initAgents — AGENTS.md is additive, never overwritten", () => {
  test("appends the MCP section to an existing AGENTS.md, preserving the user's conventions", async () => {
    const dir = await freshDir()
    const existing = "# AGENTS.md\n\nMy existing conventions.\n"
    await writeFile(join(dir, "AGENTS.md"), existing)

    const result = await initAgents(dir)
    expect(actionFor(result, "AGENTS.md")).toBe("appended")
    const md = await read(dir, "AGENTS.md")
    expect(md).toContain("My existing conventions.") // preserved
    expect(md).toContain("## MCP server") // appended
    // --force doesn't change the additive behavior — it still appends, never overwrites.
  })

  test("does not double-append when the section is already present (even with --force)", async () => {
    const dir = await freshDir()
    await initAgents(dir) // writes AGENTS.md with the section
    const once = await read(dir, "AGENTS.md")

    const result = await initAgents(dir, { force: true })
    expect(actionFor(result, "AGENTS.md")).toBe("present")
    expect(await read(dir, "AGENTS.md")).toBe(once)
    // Exactly one MCP-server heading — no duplication.
    expect(once.match(/## MCP server/g)?.length).toBe(1)
  })

  test("appends a separator when the existing file lacks a trailing newline", async () => {
    const dir = await freshDir()
    await writeFile(join(dir, "AGENTS.md"), "# AGENTS.md\n\nno trailing newline") // no final \n
    await initAgents(dir)
    const md = await read(dir, "AGENTS.md")
    expect(md).toContain("no trailing newline\n\n## MCP server")
  })
})

describe("renderInitAgents", () => {
  test("reports each file's action and a success footer when something was written", async () => {
    const dir = await freshDir()
    const out = renderInitAgents(await initAgents(dir))
    expect(out).toContain("✓ wrote .mcp.json")
    expect(out).toContain("✓ wrote .cursor/mcp.json")
    expect(out).toContain("MCP is now registered")
  })

  test("reports skips and a no-op footer when everything already exists", async () => {
    const dir = await freshDir()
    await initAgents(dir)
    const out = renderInitAgents(await initAgents(dir))
    expect(out).toContain("• skipped .mcp.json")
    expect(out).toContain("• kept AGENTS.md")
    expect(out).toContain("Nothing to do")
  })

  test("notes the appended action", async () => {
    const dir = await freshDir()
    await writeFile(join(dir, "AGENTS.md"), "# AGENTS.md\n\nrules\n")
    const out = renderInitAgents(await initAgents(dir))
    expect(out).toContain("✓ appended MCP section to AGENTS.md")
  })
})

describe("runInitAgents", () => {
  test("non-json prints the human report and returns true", async () => {
    const dir = await freshDir()
    const logs: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => logs.push(a.join(" "))
    try {
      const ok = await runInitAgents(dir)
      expect(ok).toBe(true)
    } finally {
      console.log = orig
    }
    expect(logs.join("\n")).toContain("nifra init-agents")
    expect(logs.join("\n")).toContain("✓ wrote .mcp.json")
  })

  test("--json prints the structured result", async () => {
    const dir = await freshDir()
    const logs: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => logs.push(a.join(" "))
    try {
      await runInitAgents(dir, { json: true })
    } finally {
      console.log = orig
    }
    const parsed = JSON.parse(logs.join("\n")) as InitAgentsResult
    expect(parsed.files.map((f) => f.path)).toEqual([
      ".mcp.json",
      ".cursor/mcp.json",
      "CLAUDE.md",
      "AGENTS.md",
    ])
    expect(parsed.cwd).toBe(dir)
  })

  test("--force is threaded through", async () => {
    const dir = await freshDir()
    await writeFile(join(dir, "CLAUDE.md"), "# stale\n")
    const orig = console.log
    console.log = () => {}
    try {
      await runInitAgents(dir, { force: true })
    } finally {
      console.log = orig
    }
    expect(await read(dir, "CLAUDE.md")).toContain("nifra MCP server")
  })
})

// One end-to-end check that the dispatcher wires `nifra init-agents` and confines writes to the cwd.
describe("CLI dispatch (subprocess)", () => {
  const CLI = join(import.meta.dir, "../src/cli.ts")
  test("`nifra init-agents` runs in the cwd, writes the files, exits 0", async () => {
    const dir = await freshDir()
    const proc = Bun.spawn(["bun", CLI, "init-agents"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(0)
    expect(stdout).toContain("✓ wrote .mcp.json")
    expect(await read(dir, ".mcp.json")).toContain('"nifra"')
    expect(await read(dir, ".cursor/mcp.json")).toContain('"nifra"')
  })

  test("`nifra init-agents` appears in --help", async () => {
    const proc = Bun.spawn(["bun", CLI, "--help"], { stdout: "pipe", stderr: "pipe" })
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(0)
    expect(stdout).toContain("nifra init-agents")
  })
})
