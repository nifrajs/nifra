import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { readConfigTarget, writeConfigTarget } from "../src/config-target.ts"
import { resolveTarget } from "../src/port.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

const CLI = resolve(import.meta.dir, "../src/cli.ts")
let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-config-target-")
})
afterEach(() => removeFixtureRoot(root))

async function nifra(...args: string[]): Promise<{ exit: number; out: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exit, out: stdout + stderr }
}

const config = (): string => readFileSync(join(root, "nifra.config.ts"), "utf8")

describe("the target in nifra.config.ts", () => {
  test("is read without running the config, ignoring a commented-out line", () => {
    writeAppFile(
      root,
      "nifra.config.ts",
      '// export const target = "vercel"\nexport const target: string = "node"\n',
    )
    expect(readConfigTarget(root)).toBe("node")
  })

  test("is rewritten in place, keeping its annotation, or appended", () => {
    writeAppFile(
      root,
      "nifra.config.ts",
      'export const target: string = "node"\nexport const x = 1\n',
    )
    expect(writeConfigTarget(root, "deno")).toBe("node")
    expect(config()).toBe('export const target: string = "deno"\nexport const x = 1\n')

    writeAppFile(root, "nifra.config.ts", 'export const clientModule = "x"\n')
    expect(writeConfigTarget(root, "vercel")).toBeUndefined()
    expect(config()).toEndWith('\nexport const target = "vercel"\n')
    expect(readConfigTarget(root)).toBe("vercel")
  })

  test("decides nifra port's target before any script heuristic", async () => {
    writeAppFile(root, "nifra.config.ts", 'export const target = "deno"\n')
    writeAppFile(root, "package.json", '{ "scripts": { "deploy": "vercel deploy --prebuilt" } }\n')
    expect(await resolveTarget(root)).toEqual({ target: "deno", source: "config" })
    expect(await resolveTarget(root, "node")).toEqual({ target: "node", source: "flag" })
  })

  test("maps a configured public deployment adapter to its base runtime from package metadata", async () => {
    writeAppFile(
      root,
      "package.json",
      JSON.stringify({ dependencies: { "@nifrajs/deploy-fly": "workspace:*" } }),
    )
    writeAppFile(
      root,
      "node_modules/@nifrajs/deploy-fly/package.json",
      JSON.stringify({
        name: "@nifrajs/deploy-fly",
        nifra: { deploymentAdapter: { apiVersion: 1, id: "fly", baseTarget: "node" } },
      }),
    )
    writeAppFile(root, "nifra.config.ts", 'export const target = "fly"\n')

    expect(await resolveTarget(root)).toEqual({
      target: "node",
      source: "adapter",
      adapterId: "fly",
    })
    expect(await resolveTarget(root, "fly")).toEqual({
      target: "node",
      source: "adapter",
      adapterId: "fly",
    })
  })

  test("the renamed cf-pages is refused with its new name", async () => {
    writeAppFile(root, "nifra.config.ts", 'export const target = "cf-pages"\n')
    await expect(resolveTarget(root)).rejects.toThrow(
      '[nifra] the target in nifra.config.ts "cf-pages" is now "cloudflare"',
    )
    await expect(resolveTarget(root, "cf-pages")).rejects.toThrow(
      '[nifra] the --target "cf-pages" is now "cloudflare"',
    )
  })
})

describe("nifra target", () => {
  test("shows the target, switches it, and refuses an unknown one", async () => {
    writeAppFile(root, "nifra.config.ts", 'export const clientModule = "x"\n')
    const shown = await nifra("target")
    expect(shown.exit).toBe(0)
    expect(shown.out).toContain("target: bun")

    const switched = await nifra("target", "cloudflare", "--json")
    expect(switched.exit).toBe(0)
    expect(JSON.parse(switched.out)).toMatchObject({
      ok: true,
      target: "cloudflare",
      changed: true,
    })
    expect(readConfigTarget(root)).toBe("cloudflare")

    const again = await nifra("target", "node")
    expect(again.out).toContain("✓ target: node (was cloudflare)")

    const unknown = await nifra("target", "cf-pages")
    expect(unknown.exit).not.toBe(0)
    expect(unknown.out).toContain('the target "cf-pages" is now "cloudflare"')
    expect(readConfigTarget(root)).toBe("node")
  })
})

test("build refuses a Vercel runtime after a non-Vercel target override, before wiping output", async () => {
  writeAppFile(root, "routes/index.tsx", "export default function Page() {}")
  writeAppFile(
    root,
    "nifra.config.ts",
    `export const adapter = {}
export const clientModule = "./client.ts"
export const target = "vercel"
export const vercelRuntime = "node"`,
  )
  writeAppFile(root, "dist/keep", "last deploy")
  writeAppFile(root, ".nifra-build/keep", "last work")
  const result = await nifra("build", "--target", "bun")
  expect(result.exit).not.toBe(0)
  expect(result.out).toContain('vercelRuntime is only supported for target "vercel"')
  expect(readFileSync(join(root, "dist/keep"), "utf8")).toBe("last deploy")
  expect(readFileSync(join(root, ".nifra-build/keep"), "utf8")).toBe("last work")
})
