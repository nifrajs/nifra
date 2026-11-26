import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExtensionHost } from "../src/extensions.ts"

const tempRoots: string[] = []

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop()!, { recursive: true, force: true })
})

describe("ExtensionHost", () => {
  test("loads commands and tools and rolls back a broken reload", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    const extension = join(cwd, "extension.ts")
    await writeFile(
      extension,
      `export default ({ registerCommand, registerTool }) => {
        registerCommand("hello", async () => "hello")
        registerTool({ name: "ping", description: "ping", execute: async () => "pong" })
      }`,
    )
    const host = new ExtensionHost({ cwd, roots: ["extension.ts"] })
    const first = await host.reload()
    expect(first.rolledBack).toBe(false)
    expect(host.availableCommands).toEqual(["hello"])
    expect(host.availableTools.map((tool) => tool.name)).toEqual(["ping"])

    await writeFile(extension, `export default () => { throw new Error("broken") }`)
    const second = await host.reload()
    expect(second.rolledBack).toBe(true)
    expect(host.availableCommands).toEqual(["hello"])
    expect(host.availableTools.map((tool) => tool.name)).toEqual(["ping"])
  })

  test("denies capabilities that were not trusted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    await mkdir(join(cwd, "extensions"))
    await writeFile(
      join(cwd, "extensions", "network.ts"),
      `export const capabilities = ["network"]\nexport default () => {}`,
    )
    const host = new ExtensionHost({ cwd, roots: ["extensions/network.ts"] })
    const result = await host.reload()
    expect(result.rolledBack).toBe(true)
    expect(result.error).toContain("untrusted capability")
  })

  test("reuses the imported module when reloading unchanged extension code", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    await writeFile(
      join(cwd, "extension.ts"),
      `const id = crypto.randomUUID()
       export default ({ registerProvider }) => registerProvider({ name: "example", description: id })`,
    )
    const host = new ExtensionHost({ cwd, roots: ["extension.ts"] })
    try {
      expect((await host.reload()).rolledBack).toBe(false)
      const before = host.availableProviders[0]?.description
      expect(typeof before).toBe("string")
      expect((await host.reload()).rolledBack).toBe(false)
      expect(host.availableProviders[0]?.description).toBe(before)
    } finally {
      await host.close()
    }
  })

  test("keeps unchanged activations live through replacement and rollback", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    const stable = join(cwd, "stable.ts")
    const changing = join(cwd, "changing.ts")
    await writeFile(
      stable,
      `let open = true
       export default ({ registerCommand }) => {
         registerCommand("stable", () => open)
         return { dispose: () => { open = false } }
       }`,
    )
    await writeFile(
      changing,
      'export default ({ registerCommand }) => registerCommand("changed", () => 1)',
    )
    const host = new ExtensionHost({ cwd, roots: ["stable.ts", "changing.ts"] })
    try {
      expect((await host.reload()).rolledBack).toBe(false)
      const before = host.extensions[0]
      const runStable = host.command("stable")
      expect(runStable).toBeDefined()
      await writeFile(
        changing,
        'export default ({ registerCommand }) => registerCommand("stable", () => 2)',
      )
      expect((await host.reload()).rolledBack).toBe(true)
      expect(host.command("stable")).toBe(runStable)
      await writeFile(
        changing,
        'export default ({ registerCommand }) => registerCommand("updated", () => 2)',
      )
      expect((await host.reload()).rolledBack).toBe(false)
      expect(host.extensions[0]).toBe(before)
      expect(host.availableCommands).toEqual(["stable", "updated"])
      const context = {
        cwd,
        registerCommand: () => {},
        registerTool: () => {},
        registerWorkflow: () => {},
        registerSubagent: () => {},
        registerProvider: () => {},
        on: () => {},
      }
      expect(await runStable?.("", context)).toBe(true)
      await host.close()
      expect(await runStable?.("", context)).toBe(false)
    } finally {
      await host.close()
    }
  })

  test("retries a failed entry evaluation without editing its source", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    const config = join(cwd, "config.txt")
    await writeFile(
      join(cwd, "extension.ts"),
      `import { readFileSync } from "node:fs"
       const description = readFileSync(${JSON.stringify(config)}, "utf8")
       export default ({ registerProvider }) => registerProvider({ name: "example", description })`,
    )
    const host = new ExtensionHost({ cwd, roots: ["extension.ts"] })
    try {
      expect((await host.reload()).rolledBack).toBe(true)
      await writeFile(config, "ready")
      expect((await host.reload()).rolledBack).toBe(false)
      expect(host.provider("example")?.description).toBe("ready")
    } finally {
      await host.close()
    }
  })

  test("rejects extension roots outside the project", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    const host = new ExtensionHost({ cwd, roots: ["../outside.ts"] })
    const result = await host.reload()
    expect(result.rolledBack).toBe(true)
    expect(result.error).toContain("escapes project root")
  })

  test("stages and runs a customizable workflow after validation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    const extension = join(cwd, "workflow.ts")
    await writeFile(
      extension,
      `export default ({ registerWorkflow }) => {
        registerWorkflow("release", () => ({
          type: "sequence",
          steps: [
            { type: "task", id: "build", run: async (context) => { context.set("built", true) } },
            { type: "verify", id: "verify", run: async (context) => context.values.get("built") === true },
          ],
        }))
      }`,
    )
    const validated: string[] = []
    const host = new ExtensionHost({
      cwd,
      roots: ["workflow.ts"],
      validate: (path) => {
        validated.push(path)
      },
    })
    await expect(host.reload()).resolves.toMatchObject({ rolledBack: false })
    expect(validated).toEqual([extension])
    expect(host.availableWorkflows).toEqual(["release"])
    await expect(host.runWorkflow("release")).resolves.toMatchObject({
      ok: true,
      completed: ["build", "verify"],
    })
  })

  test("exposes customizable subagent roles and provider descriptors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    await writeFile(
      join(cwd, "roles.ts"),
      `export default ({ registerSubagent, registerProvider }) => {
        registerSubagent({ name: "reviewer", description: "Review changes", prompt: "Review safely" })
        registerProvider({ name: "local", description: "Local model" })
      }`,
    )
    const host = new ExtensionHost({ cwd, roots: ["roles.ts"] })
    await expect(host.reload()).resolves.toMatchObject({ rolledBack: false })
    expect(host.availableSubagents.map((role) => role.name)).toEqual(["reviewer"])
    expect(host.provider("local")?.description).toBe("Local model")
  })
})
