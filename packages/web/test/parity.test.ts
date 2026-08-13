import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectIdentityParity } from "../src/internal/parity.ts"

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
