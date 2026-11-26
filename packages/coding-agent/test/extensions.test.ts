import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ExtensionContext, ExtensionHost } from "../src/extensions.ts"

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

  test("denies capabilities that were not trusted before evaluating top-level code", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    const marker = join(cwd, "executed.txt")
    await mkdir(join(cwd, "extensions"))
    await writeFile(
      join(cwd, "extensions", "network.ts"),
      `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "ran")\nexport const capabilities = ["network", // required\n]\nexport default () => {}`,
    )
    const host = new ExtensionHost({ cwd, roots: ["extensions/network.ts"] })
    const result = await host.reload()
    expect(result.rolledBack).toBe(true)
    expect(result.error).toContain("untrusted capability")
    await expect(Bun.file(marker).exists()).resolves.toBe(false)
  })

  test("denies untrusted capabilities before top-level code even after block-followed regex literals", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    const marker = join(cwd, "executed-after-regex.txt")
    await mkdir(join(cwd, "extensions"))
    await writeFile(
      join(cwd, "extensions", "regex-after-block.ts"),
      [
        `import { writeFileSync } from "node:fs"`,
        `function helper() {}`,
        `/"([^"]*)"/.test('""')`,
        `type Config = { flag?: boolean }`,
        `if (false) /'/g.test("")`,
        `writeFileSync(${JSON.stringify(marker)}, "ran")`,
        `export const capabilities = ["network"]`,
        `export default () => {}`,
      ].join("\n"),
    )
    const host = new ExtensionHost({ cwd, roots: ["extensions/regex-after-block.ts"] })
    const result = await host.reload()
    expect(result.rolledBack).toBe(true)
    expect(result.error).toContain("untrusted capability")
    await expect(Bun.file(marker).exists()).resolves.toBe(false)
  })

  test("ignores string, template, and regex literals matching capabilities syntax", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    await mkdir(join(cwd, "extensions"))
    await writeFile(
      join(cwd, "extensions", "docs-example.ts"),
      [
        `const example = 'export const capabilities = ["network"]'`,
        "const templated = `example: export const capabilities = ${example}`",
        `const pattern = /"export const capabilities = ['network']"/`,
        `export const metadata = { example, templated, pattern: pattern.source }`,
        `export default ({ registerCommand }) => {`,
        `  registerCommand("docs-example", async () => "ok")`,
        `}`,
      ].join("\n"),
    )
    const host = new ExtensionHost({ cwd, roots: ["extensions/docs-example.ts"] })
    const result = await host.reload()
    expect(result.rolledBack).toBe(false)
    expect(host.availableCommands).toEqual(["docs-example"])
  })

  test("handles BOM, unicode terminators, tagged templates, generic types, and multi-declarators", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    const marker = join(cwd, "executed-edge.txt")
    await mkdir(join(cwd, "extensions"))

    // 1. BOM + multi-declarator + generic type comma + \u2028 line comment
    await writeFile(
      join(cwd, "extensions", "bom-multi.ts"),
      `\uFEFFimport { writeFileSync } from "node:fs"\n// comment\u2028writeFileSync(${JSON.stringify(marker)}, "ran")\nexport const version = 1, capabilities: Record<string, never> | readonly string[] = ["network"]\nexport default () => {}`,
    )
    const blockedHost = new ExtensionHost({ cwd, roots: ["extensions/bom-multi.ts"] })
    const blocked = await blockedHost.reload()
    expect(blocked.rolledBack).toBe(true)
    expect(blocked.error).toContain("untrusted capability")
    await expect(Bun.file(marker).exists()).resolves.toBe(false)

    // 2. Valid edge cases: String.raw`\u{110000}`, regex in `${/[}]/}`, `of / 2`, mutable let reassigned to []
    await writeFile(
      join(cwd, "extensions", "valid-edges.ts"),
      [
        "const raw = String.raw`\\u{110000} \\u{bad`",
        "const braceRegex = `${/[}]/.source}`",
        "const of = 4; const half = (of / 2)",
        'export let capabilities = ["network"]',
        "capabilities = []",
        'export default ({ registerCommand }) => { registerCommand("edge-ok", async () => raw + braceRegex + half) }',
      ].join("\n"),
    )
    const validHost = new ExtensionHost({ cwd, roots: ["extensions/valid-edges.ts"] })
    const loaded = await validHost.reload()
    expect(loaded.rolledBack).toBe(false)
    expect(validHost.availableCommands).toEqual(["edge-ok"])

    // 3. Derived `.slice(1)` + shadowed Object.freeze + ASI boundary defers to runtime value `[]`
    await writeFile(
      join(cwd, "extensions", "derived-shadow.ts"),
      [
        'export const capabilities = ["network"].slice(1)',
        'export default ({ registerCommand }) => registerCommand("derived-ok", async () => "ok")',
      ].join("\n"),
    )
    const derivedHost = new ExtensionHost({ cwd, roots: ["extensions/derived-shadow.ts"] })
    expect((await derivedHost.reload()).rolledBack).toBe(false)
    expect(derivedHost.availableCommands).toEqual(["derived-ok"])

    // 4. Local Object binding shadowing `Object.freeze` + escaped \u2028 continuation
    await writeFile(
      join(cwd, "extensions", "shadow-freeze.ts"),
      [
        "const Object = { freeze: () => [] as string[] }",
        'export const capabilities = Object.freeze(["network"])',
        'export default ({ registerCommand }) => registerCommand("shadow-ok", async () => "ok")',
      ].join("\n"),
    )
    const shadowHost = new ExtensionHost({ cwd, roots: ["extensions/shadow-freeze.ts"] })
    expect((await shadowHost.reload()).rolledBack).toBe(false)
    expect(shadowHost.availableCommands).toEqual(["shadow-ok"])

    // Object.keys in the extension must not disable `Object.freeze([...])` capability preflight
    const markerFreeze = join(cwd, "executed-object-keys.txt")
    await writeFile(
      join(cwd, "extensions", "object-keys-with-freeze.ts"),
      [
        `import { writeFileSync } from "node:fs"`,
        `writeFileSync(${JSON.stringify(markerFreeze)}, "ran")`,
        `export const capabilities = Object.freeze(["network"])`,
        `export default ({ registerCommand }) => {`,
        `  const keys = Object.keys(process.env)`,
        `  registerCommand("keys", async () => keys.length)`,
        `}`,
      ].join("\n"),
    )
    const keysFreezeHost = new ExtensionHost({
      cwd,
      roots: ["extensions/object-keys-with-freeze.ts"],
    })
    const keysResult = await keysFreezeHost.reload()
    expect(keysResult.rolledBack).toBe(true)
    expect(keysResult.error).toContain("untrusted capability")
    await expect(Bun.file(markerFreeze).exists()).resolves.toBe(false)

    // Default parameters and type annotations referencing `Object` must not disable freeze preflight
    const markerDefaultParam = join(cwd, "executed-default-param.txt")
    await writeFile(
      join(cwd, "extensions", "default-param-freeze.ts"),
      [
        `import { writeFileSync } from "node:fs"`,
        `writeFileSync(${JSON.stringify(markerDefaultParam)}, "ran")`,
        `const cfg: Object = {}`,
        `export const capabilities = Object.freeze(["network"])`,
        `export default function make(opts = Object.create(null)) { return opts ?? cfg }`,
      ].join("\n"),
    )
    const defaultParamHost = new ExtensionHost({
      cwd,
      roots: ["extensions/default-param-freeze.ts"],
    })
    const defaultParamResult = await defaultParamHost.reload()
    expect(defaultParamResult.rolledBack).toBe(true)
    expect(defaultParamResult.error).toContain("untrusted capability")
    await expect(Bun.file(markerDefaultParam).exists()).resolves.toBe(false)

    await writeFile(
      join(cwd, "extensions", "u2028-cont.ts"),
      [
        'export const capabilities = ["net\\\u2028work"]',
        'export default ({ registerCommand }) => registerCommand("net-ok", async () => "ok")',
      ].join("\n"),
    )
    const trustedNetHost = new ExtensionHost({
      cwd,
      roots: ["extensions/u2028-cont.ts"],
      trustedCapabilities: ["network"],
    })
    expect((await trustedNetHost.reload()).rolledBack).toBe(false)
    expect(trustedNetHost.availableCommands).toEqual(["net-ok"])
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

  test("a callback the factory kept registers into the live host, across reloads", async () => {
    const unused: Omit<ExtensionContext, "cwd"> = {
      registerCommand: () => {},
      registerTool: () => {},
      registerWorkflow: () => {},
      registerSubagent: () => {},
      registerProvider: () => {},
      on: () => {},
    }
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    await writeFile(
      join(cwd, "late.ts"),
      `export default ({ registerCommand, on }) => {
         let installed = 0
         registerCommand("install", () => {
           const name = "extra" + ++installed
           registerCommand(name, () => name)
           on("ping", (payload) => payload.seen.push(name))
         })
       }`,
    )
    const host = new ExtensionHost({ cwd, roots: ["late.ts"] })
    const install = () => host.command("install")?.("", { ...unused, cwd })
    const pinged = async () => {
      const seen: string[] = []
      await host.emit("ping", { seen })
      return seen
    }
    try {
      await host.reload()
      install()
      expect(host.availableCommands).toEqual(["extra1", "install"])
      expect(await pinged()).toEqual(["extra1"])
      await host.reload()
      install()
      expect(host.availableCommands).toEqual(["extra1", "extra2", "install"])
      expect(await pinged()).toEqual(["extra1", "extra2"])
    } finally {
      await host.close()
    }
  })

  test("what a handler or workflow registers survives a reload that keeps the extension", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    await writeFile(
      join(cwd, "lazy.ts"),
      `export default ({ on, registerWorkflow }) => {
         let installed = false
         on("setup", (_payload, context) => {
           if (installed) return
           installed = true
           context.registerCommand("from-event", () => 1)
           context.on("ping", (payload) => payload.seen.push("late"))
         })
         registerWorkflow("flow", (context) => {
           context.registerCommand("from-workflow", () => 2)
           return { type: "sequence", steps: [] }
         })
       }`,
    )
    const host = new ExtensionHost({ cwd, roots: ["lazy.ts"] })
    const pinged = async () => {
      const seen: string[] = []
      await host.emit("ping", { seen })
      return seen
    }
    try {
      await host.reload()
      await host.emit("setup", {})
      await host.runWorkflow("flow")
      for (let reload = 0; reload < 2; reload++) {
        expect(host.availableCommands).toEqual(["from-event", "from-workflow"])
        expect(await pinged()).toEqual(["late"])
        await host.reload()
        await host.emit("setup", {})
      }
    } finally {
      await host.close()
    }
  })

  test("close runs every disposer and reports the first failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nifra-agent-extension-"))
    tempRoots.push(cwd)
    await writeFile(
      join(cwd, "bad.ts"),
      'export default () => ({ dispose: () => { throw new Error("stuck") } })',
    )
    await writeFile(
      join(cwd, "good.ts"),
      `import { writeFileSync } from "node:fs"
       export default ({ cwd }) => ({ dispose: () => writeFileSync(cwd + "/closed", "") })`,
    )
    const host = new ExtensionHost({ cwd, roots: ["bad.ts", "good.ts"] })
    expect((await host.reload()).rolledBack).toBe(false)
    await expect(host.close()).rejects.toThrow("stuck")
    expect(existsSync(join(cwd, "closed"))).toBe(true)
  })
})
