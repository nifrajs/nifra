import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { MCP_CLI_VERSION } from "create-nifra/agent-files"
import {
  collectStaleMcpPins,
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

describe("safeJoin - confines writes to the project root", () => {
  test("resolves a normal relative path under cwd", () => {
    const root = resolve("/proj")
    expect(safeJoin(root, ".cursor/mcp.json")).toBe(join(root, ".cursor", "mcp.json"))
    expect(safeJoin(root, "CLAUDE.md")).toBe(join(root, "CLAUDE.md"))
  })

  test("rejects a path that escapes the root (traversal)", () => {
    expect(() => safeJoin("/proj", "../evil")).toThrow(/outside the project root/)
    expect(() => safeJoin("/proj", "../../etc/passwd")).toThrow(/outside the project root/)
  })

  test("rejects an absolute escape", () => {
    expect(() => safeJoin("/proj", "/etc/passwd")).toThrow(/outside the project root/)
  })
})

describe("initAgents - fresh project", () => {
  test("writes all four agent-discovery files", async () => {
    const dir = await freshDir()
    const result = await initAgents(dir)

    // .mcp.json - Claude Code's exact shape, registering the bin-owning package.
    const mcp = JSON.parse(await read(dir, ".mcp.json")) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(mcp.mcpServers.nifra?.command).toBe("bunx")
    // Pinned to an exact @nifrajs/cli version so a stale bunx cache can't shadow it.
    expect(mcp.mcpServers.nifra?.args?.[0]).toMatch(/^@nifrajs\/cli@\d+\.\d+\.\d+/)
    expect(mcp.mcpServers.nifra?.args?.[1]).toBe("mcp")

    // .cursor/mcp.json - same server config, byte-identical (single source of truth).
    expect(await read(dir, ".cursor/mcp.json")).toBe(await read(dir, ".mcp.json"))

    // CLAUDE.md - MCP-first preamble that imports AGENTS.md on its own line (no drift).
    const claude = await read(dir, "CLAUDE.md")
    expect(claude).toContain("nifra MCP server")
    expect(claude).toContain("nifra_check")
    expect(claude.split("\n")).toContain("@AGENTS.md")

    // AGENTS.md - written fresh (none existed) with the MCP section.
    const agents = await read(dir, "AGENTS.md")
    expect(agents).toContain("## MCP server")
    expect(agents).toMatch(/bunx @nifrajs\/cli@\d+\.\d+\.\d+\S* mcp/)

    expect(result.files.map((f) => f.action)).toEqual(["wrote", "wrote", "wrote", "wrote"])
  })
})

describe("initAgents - no-clobber + idempotency", () => {
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
    // The other files still land - only the existing one is spared.
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

describe("initAgents - --force", () => {
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

// `safeJoin` only proves the textual path stays inside the project. A symlink planted at one of
// those names redirects the write to wherever it points - outside the root, with the running user's
// privileges - and `--force` is exactly the flag that would follow it.
describe("initAgents - symlink guards", () => {
  test("refuses to write through a symlinked file, even with --force", async () => {
    const dir = await freshDir()
    const outside = await freshDir()
    const victim = join(outside, "victim.md")
    await writeFile(victim, "untouched\n")
    await symlink(victim, join(dir, "CLAUDE.md"))

    await expect(initAgents(dir, { force: true })).rejects.toThrow(/non-regular file/)
    expect(await readFile(victim, "utf8")).toBe("untouched\n")
  })

  test("refuses to write through a symlinked parent directory", async () => {
    const dir = await freshDir()
    const outside = await freshDir()
    await symlink(outside, join(dir, ".cursor"))

    await expect(initAgents(dir, { force: true })).rejects.toThrow(/unsafe parent path/)
    expect(existsSync(join(outside, "mcp.json"))).toBe(false)
  })

  test("refuses to append to a symlinked AGENTS.md", async () => {
    const dir = await freshDir()
    const outside = await freshDir()
    const victim = join(outside, "notes.md")
    await writeFile(victim, "untouched\n")
    // CLAUDE.md is written before AGENTS.md, so only AGENTS.md is symlinked here.
    await symlink(victim, join(dir, "AGENTS.md"))

    await expect(initAgents(dir)).rejects.toThrow(/non-regular file/)
    expect(await readFile(victim, "utf8")).toBe("untouched\n")
  })

  test("leaves no temp file behind on a successful write", async () => {
    const dir = await freshDir()
    await initAgents(dir)
    const stray = (await readdir(dir)).filter((name) => name.includes(".nifra-"))
    expect(stray).toEqual([])
  })
})

describe("initAgents - AGENTS.md is additive, never overwritten", () => {
  test("appends the MCP section to an existing AGENTS.md, preserving the user's conventions", async () => {
    const dir = await freshDir()
    const existing = "# AGENTS.md\n\nMy existing conventions.\n"
    await writeFile(join(dir, "AGENTS.md"), existing)

    const result = await initAgents(dir)
    expect(actionFor(result, "AGENTS.md")).toBe("appended")
    const md = await read(dir, "AGENTS.md")
    expect(md).toContain("My existing conventions.") // preserved
    expect(md).toContain("## MCP server") // appended
    // --force doesn't change the additive behavior - it still appends, never overwrites.
  })

  test("does not double-append when the section is already present (even with --force)", async () => {
    const dir = await freshDir()
    await initAgents(dir) // writes AGENTS.md with the section
    const once = await read(dir, "AGENTS.md")

    const result = await initAgents(dir, { force: true })
    expect(actionFor(result, "AGENTS.md")).toBe("present")
    expect(await read(dir, "AGENTS.md")).toBe(once)
    // Exactly one MCP-server heading - no duplication.
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

describe("initAgents --sync-mcp - re-pins the MCP launch and nothing else", () => {
  const STALE = "3.1.0"
  const pin = (version: string) => `@nifrajs/cli@${version}`
  const launch = (version: string) => `bunx ${pin(version)} mcp`

  // Hand-edited files a real app accumulates: CRLF, a second server, 4-space indent, non-ASCII prose,
  // and stale-version mentions that are NOT the launch pin (an upgrade note, a later section).
  const mcpJsonCrlf = (version: string) =>
    [
      "{",
      '    "mcpServers": {',
      `        "nifra": { "command": "bunx", "args": ["${pin(version)}", "mcp"] },`,
      '        "other": { "command": "npx", "args": ["other-mcp@1.0.0"], "env": { "NOTE": "@nifrajs/cli@3.1.0 is not a pin here" } }',
      "    }",
      "}",
      "",
    ].join("\r\n")
  const cursorJson = (version: string) =>
    `{\n  "mcpServers": {\n    "nifra": {\n      "command": "bunx",\n      "args": [\n        "${pin(version)}",\n        "mcp"\n      ]\n    }\n  }\n}\n`
  const claude = (version: string) =>
    `# House rules ✓ café\n\nOur agent launches \`${launch(version)}\` - keep it that way.\n\nUpgraded from @nifrajs/cli@3.0.0 in June (history, not a launch).\n\n@AGENTS.md\n`
  const agents = (version: string) =>
    [
      "# Conventions",
      "",
      `Before the upgrade we ran \`${launch(STALE)}\` by hand.`,
      "",
      "## MCP server",
      "",
      `This project ships a nifra MCP server - launch it with \`${launch(version)}\`.`,
      "",
      "## Release notes",
      "",
      `- 2026-06: \`${launch(STALE)}\` shipped.`,
      "",
    ].join("\n")

  async function staleProject(): Promise<string> {
    const dir = await freshDir()
    await mkdir(join(dir, ".cursor"))
    await writeFile(join(dir, ".mcp.json"), mcpJsonCrlf(STALE))
    await writeFile(join(dir, ".cursor/mcp.json"), cursorJson(STALE))
    await writeFile(join(dir, "CLAUDE.md"), claude(STALE))
    await writeFile(join(dir, "AGENTS.md"), agents(STALE))
    return dir
  }
  const snapshot = async (dir: string): Promise<Record<string, string>> =>
    Object.fromEntries(
      await Promise.all(
        [".mcp.json", ".cursor/mcp.json", "CLAUDE.md", "AGENTS.md"].map(
          async (rel) => [rel, await read(dir, rel)] as const,
        ),
      ),
    )

  test("a stale 3.1.0 pin is rewritten to the current version in all four files", async () => {
    const dir = await staleProject()
    const result = await initAgents(dir, { syncMcp: true })
    expect(result.syncedTo).toBe(MCP_CLI_VERSION)
    for (const path of [".mcp.json", ".cursor/mcp.json", "CLAUDE.md", "AGENTS.md"]) {
      expect(actionFor(result, path)).toBe("synced")
      expect(result.files.find((f) => f.path === path)?.note).toBe(`${STALE} -> ${MCP_CLI_VERSION}`)
    }
    const mcp = JSON.parse(await read(dir, ".mcp.json")) as {
      mcpServers: Record<string, { args: string[] }>
    }
    expect(mcp.mcpServers.nifra?.args).toEqual([pin(MCP_CLI_VERSION), "mcp"])
  })

  test("every byte outside the pin stays as the user wrote it", async () => {
    const dir = await staleProject()
    await initAgents(dir, { syncMcp: true })
    expect(await snapshot(dir)).toEqual({
      ".mcp.json": mcpJsonCrlf(MCP_CLI_VERSION),
      ".cursor/mcp.json": cursorJson(MCP_CLI_VERSION),
      "CLAUDE.md": claude(MCP_CLI_VERSION),
      // Only the `## MCP server` section is ours: the note above it and the release notes below keep 3.1.0.
      "AGENTS.md": agents(MCP_CLI_VERSION),
    })
    expect(await read(dir, "AGENTS.md")).toContain(`Before the upgrade we ran \`${launch(STALE)}\``)
    expect(await read(dir, "AGENTS.md")).toContain(`- 2026-06: \`${launch(STALE)}\` shipped.`)
  })

  test("running it twice is a no-op", async () => {
    const dir = await staleProject()
    await initAgents(dir, { syncMcp: true })
    const once = await snapshot(dir)
    const again = await initAgents(dir, { syncMcp: true })
    expect(again.files.map((f) => f.action)).toEqual(["present", "present", "present", "present"])
    expect(await snapshot(dir)).toEqual(once)
    expect(renderInitAgents(again)).toContain("Nothing to re-pin")
  })

  test("pins to the nifra the project installs, not the running CLI", async () => {
    const dir = await staleProject()
    await mkdir(join(dir, "node_modules/@nifrajs/cli"), { recursive: true })
    await writeFile(
      join(dir, "node_modules/@nifrajs/cli/package.json"),
      JSON.stringify({ name: "@nifrajs/cli", version: "3.4.2" }),
    )
    const result = await initAgents(dir, { syncMcp: true })
    expect(result.syncedTo).toBe("3.4.2")
    expect(await read(dir, ".cursor/mcp.json")).toBe(cursorJson("3.4.2"))
    expect(await read(dir, "CLAUDE.md")).toBe(claude("3.4.2"))
  })

  test("creates nothing: absent files and files without a pin are reported, not repaired", async () => {
    const dir = await freshDir()
    await writeFile(join(dir, "AGENTS.md"), "# Conventions\n\nNo MCP section here.\n")
    await writeFile(join(dir, "CLAUDE.md"), `Launch with bunx ${pin("latest")} mcp\n`)
    const result = await initAgents(dir, { syncMcp: true })
    expect(result.files.map((f) => f.action)).toEqual(["skipped", "skipped", "skipped", "skipped"])
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false)
    expect(existsSync(join(dir, ".cursor"))).toBe(false)
    expect(await read(dir, "AGENTS.md")).toBe("# Conventions\n\nNo MCP section here.\n")
    expect(await read(dir, "CLAUDE.md")).toBe(`Launch with bunx ${pin("latest")} mcp\n`)
  })

  test("leaves a symlinked file alone and keeps the file mode of the ones it rewrites", async () => {
    const dir = await staleProject()
    await chmod(join(dir, "CLAUDE.md"), 0o600)
    const target = join(dir, "real-agents.md")
    await writeFile(target, agents(STALE))
    await rm(join(dir, "AGENTS.md"))
    await symlink(target, join(dir, "AGENTS.md"))
    const result = await initAgents(dir, { syncMcp: true })
    expect(actionFor(result, "AGENTS.md")).toBe("skipped")
    expect(await readFile(target, "utf8")).toBe(agents(STALE))
    expect((await stat(join(dir, "CLAUDE.md"))).mode & 0o777).toBe(0o600)
  })

  test("refuses --force alongside --sync-mcp", async () => {
    const dir = await staleProject()
    await expect(initAgents(dir, { syncMcp: true, force: true })).rejects.toThrow(
      /--sync-mcp cannot be combined with --force/,
    )
    expect(await read(dir, "CLAUDE.md")).toBe(claude(STALE))
  })

  test("a plain init-agents run points a kept stale file at --sync-mcp", async () => {
    const dir = await staleProject()
    const result = await initAgents(dir)
    expect(actionFor(result, "CLAUDE.md")).toBe("skipped")
    expect(result.files.find((f) => f.path === "CLAUDE.md")?.note).toContain(
      `pinned to ${STALE}; \`nifra init-agents --sync-mcp\` re-pins it to ${MCP_CLI_VERSION}`,
    )
    expect(await read(dir, "CLAUDE.md")).toBe(claude(STALE))
  })

  test("collectStaleMcpPins reads without writing", async () => {
    const dir = await staleProject()
    const before = await snapshot(dir)
    expect(await collectStaleMcpPins(dir)).toEqual({
      target: MCP_CLI_VERSION,
      files: [".mcp.json", ".cursor/mcp.json", "CLAUDE.md", "AGENTS.md"].map((path) => ({
        path,
        pinned: [STALE],
      })),
    })
    expect(await snapshot(dir)).toEqual(before)
  })
})

describe("initAgents at a workspace root - the launch names the one nifra member", () => {
  const pin = (version: string) => `@nifrajs/cli@${version}`
  const cursorJson = (version: string, member?: string) =>
    `{\n  "mcpServers": {\n    "nifra": {\n      "command": "bunx",\n      "args": [\n        "${pin(version)}",\n        "mcp"${member === undefined ? "" : `,\n        "${member}"`}\n      ]\n    }\n  }\n}\n`

  /** A root that only declares `workspaces`, a framework-free `core`, and the nifra
   * `app`. nifra is installed in the member (an isolated install), not at the root. */
  async function workspace(nifraMembers: readonly string[] = ["app"]): Promise<string> {
    const dir = await freshDir()
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["core", ...nifraMembers] }),
    )
    await mkdir(join(dir, "core"))
    await writeFile(join(dir, "core/package.json"), JSON.stringify({ name: "core" }))
    for (const member of nifraMembers) {
      await mkdir(join(dir, member, "node_modules/@nifrajs/cli"), { recursive: true })
      await writeFile(
        join(dir, member, "package.json"),
        JSON.stringify({ name: member, dependencies: { "@nifrajs/core": "3.4.2" } }),
      )
      await writeFile(
        join(dir, member, "node_modules/@nifrajs/cli/package.json"),
        JSON.stringify({ name: "@nifrajs/cli", version: "3.4.2" }),
      )
    }
    return dir
  }

  test("--sync-mcp re-pins to the member's nifra and names it in both registries", async () => {
    const dir = await workspace()
    await mkdir(join(dir, ".cursor"))
    await writeFile(
      join(dir, ".mcp.json"),
      `{ "mcpServers": { "nifra": { "command": "bunx", "args": ["${pin("3.1.0")}", "mcp"] } } }\n`,
    )
    await writeFile(join(dir, ".cursor/mcp.json"), cursorJson("3.1.0"))
    await writeFile(join(dir, "CLAUDE.md"), `Launch with \`bunx ${pin("3.1.0")} mcp\`.\n`)

    const result = await initAgents(dir, { syncMcp: true })
    expect(result.syncedTo).toBe("3.4.2")
    expect(result.files.find((f) => f.path === ".mcp.json")?.note).toBe(
      "3.1.0 -> 3.4.2; launches `mcp app`",
    )
    expect(await read(dir, ".mcp.json")).toBe(
      `{ "mcpServers": { "nifra": { "command": "bunx", "args": ["${pin("3.4.2")}", "mcp", "app"] } } }\n`,
    )
    expect(await read(dir, ".cursor/mcp.json")).toBe(cursorJson("3.4.2", "app"))
    // The markdown only describes the launch; its wording keeps everything but the version.
    expect(await read(dir, "CLAUDE.md")).toBe(`Launch with \`bunx ${pin("3.4.2")} mcp\`.\n`)

    const again = await initAgents(dir, { syncMcp: true })
    expect(again.files.slice(0, 3).map((f) => f.action)).toEqual(["present", "present", "present"])
  })

  test("a current pin with no directory is still synced, to name the member", async () => {
    const dir = await workspace()
    await writeFile(join(dir, ".mcp.json"), cursorJson("3.4.2"))
    const result = await initAgents(dir, { syncMcp: true })
    expect(actionFor(result, ".mcp.json")).toBe("synced")
    expect(result.files.find((f) => f.path === ".mcp.json")?.note).toBe("launches `mcp app`")
    expect(await read(dir, ".mcp.json")).toBe(cursorJson("3.4.2", "app"))
  })

  test("a launch that already names a directory keeps it", async () => {
    const dir = await workspace()
    const named = `{ "mcpServers": { "nifra": { "command": "bunx", "args": ["${pin("3.1.0")}", "mcp", "elsewhere"] } } }\n`
    await writeFile(join(dir, ".mcp.json"), named)
    await initAgents(dir, { syncMcp: true })
    expect(await read(dir, ".mcp.json")).toBe(named.replace(pin("3.1.0"), pin("3.4.2")))
  })

  test("a plain run writes registries that name the member", async () => {
    const dir = await workspace()
    await initAgents(dir)
    const mcp = JSON.parse(await read(dir, ".mcp.json")) as {
      mcpServers: Record<string, { args: string[] }>
    }
    expect(mcp.mcpServers.nifra?.args).toEqual([pin(MCP_CLI_VERSION), "mcp", "app"])
    expect(await read(dir, ".cursor/mcp.json")).toBe(await read(dir, ".mcp.json"))
  })

  test("with two nifra members nothing is named: the choice is the user's", async () => {
    const dir = await workspace(["app", "admin"])
    await writeFile(join(dir, ".mcp.json"), cursorJson("3.1.0"))
    const result = await initAgents(dir, { syncMcp: true })
    expect(result.files.find((f) => f.path === ".mcp.json")?.note).toBe(
      `3.1.0 -> ${MCP_CLI_VERSION}`,
    )
    expect(await read(dir, ".mcp.json")).toBe(cursorJson(MCP_CLI_VERSION))
  })
})

// One end-to-end check that the dispatcher wires `nifra init-agents` and confines writes to the cwd.
describe("CLI dispatch (subprocess)", () => {
  const CLI = join(import.meta.dir, "../src/cli.ts")
  test("`nifra init-agents` runs in the cwd, writes the files, exits 0", async () => {
    const dir = await freshDir()
    const proc = Bun.spawn([process.execPath, CLI, "init-agents"], {
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
    const proc = Bun.spawn([process.execPath, CLI, "--help"], { stdout: "pipe", stderr: "pipe" })
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(0)
    expect(stdout).toContain("nifra init-agents")
    expect(stdout).toContain("nifra init-agents --sync-mcp")
  })

  test("`nifra init-agents --sync-mcp` re-pins in the cwd and writes nothing new", async () => {
    const dir = await freshDir()
    await writeFile(join(dir, "CLAUDE.md"), "Launch `bunx @nifrajs/cli@3.1.0 mcp`.\n")
    const proc = Bun.spawn([process.execPath, CLI, "init-agents", "--sync-mcp"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(0)
    expect(stdout).toContain(`✓ re-pinned CLAUDE.md`)
    expect(await read(dir, "CLAUDE.md")).toBe(
      `Launch \`bunx @nifrajs/cli@${MCP_CLI_VERSION} mcp\`.\n`,
    )
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false)
  })
})
