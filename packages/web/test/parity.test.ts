import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectDevelopmentParityInput, collectIdentityParity } from "../src/internal/parity.ts"

test("shared identity parity resolves a workspace from an app subdirectory", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-parity-"))
  try {
    const app = join(root, "apps", "web")
    const packageDir = join(root, "packages", "kit")
    await mkdir(join(app, "node_modules", "react"), { recursive: true })
    await mkdir(join(packageDir, "node_modules", "react"), { recursive: true })
    await mkdir(join(root, "node_modules", "react"), { recursive: true })
    await mkdir(join(root, ".git"), { recursive: true })
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }),
    )
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({ name: "web", dependencies: { react: "19.2.7" } }),
    )
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "kit", dependencies: { react: "19.2.7" } }),
    )
    for (const path of [
      join(app, "node_modules", "react"),
      join(packageDir, "node_modules", "react"),
      join(root, "node_modules", "react"),
    ]) {
      await writeFile(
        join(path, "package.json"),
        JSON.stringify({ name: "react", version: "19.2.7" }),
      )
    }
    const appPackage = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as Record<
      string,
      unknown
    >
    const result = await collectIdentityParity(app, appPackage, { useWorkspaceRoot: true })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.package).toBe("react")
    expect(result.findings[0]?.copies).toHaveLength(3)
    expect(result.findings[0]?.remediation).toContain("reinstall")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("development parity counts a Svelte <style> block as css without a css import", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-parity-sfc-"))
  try {
    const routesDir = join(root, "routes")
    await mkdir(routesDir, { recursive: true })
    await writeFile(
      join(routesDir, "index.svelte"),
      '<div id="page">hi</div>\n<style>\n  #page { color: #ff3e00; }\n</style>\n',
    )
    const input = collectDevelopmentParityInput(routesDir, false)
    expect(input.css).toEqual(["css:present"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("development parity reports no css for a style-free route", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-parity-nocss-"))
  try {
    const routesDir = join(root, "routes")
    await mkdir(routesDir, { recursive: true })
    await writeFile(
      join(routesDir, "index.tsx"),
      "export default function Index() {\n  return null\n}\n",
    )
    const input = collectDevelopmentParityInput(routesDir, false)
    expect(input.css).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
