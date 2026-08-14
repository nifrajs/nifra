import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Diagnostic } from "../src/diagnostics.ts"
import { applyDiagnosticRecipe } from "../src/fix-recipes.ts"
import { resolveInsideProject } from "../src/project-path.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nifra-fix-"))
  roots.push(root)
  return root
}

const diagnostic = (file: string): Diagnostic => ({
  code: "NF-S002",
  severity: "error",
  message: "secret comparison",
  file,
  line: 1,
  fix: { recipe: "security.timing-safe-equal" },
})

/** A source checkout outside the project, the way a `link:`/workspace dependency really lives. */
async function linkedPackage(scripts: Record<string, string> | undefined): Promise<string> {
  const outside = await mkdtemp(join(tmpdir(), "nifra-package-"))
  roots.push(outside)
  await writeFile(
    join(outside, "package.json"),
    JSON.stringify({ name: "@scope/pkg", version: "1.0.0", ...(scripts ? { scripts } : {}) }),
  )
  return outside
}

/** The symlink a package manager writes for a linked dependency. */
async function linkInto(root: string, target: string): Promise<void> {
  await mkdir(join(root, "node_modules", "@scope"), { recursive: true })
  await symlink(target, join(root, "node_modules", "@scope", "pkg"), "dir")
}

const workspaceDiagnostic = (packageName: string): Diagnostic => ({
  code: "NF-C010",
  severity: "error",
  message: "stale workspace build",
  evidence: [packageName],
  fix: { recipe: "workspace-dist.rebuild" },
})

describe("project-scoped diagnostic paths", () => {
  test("rejects traversal and absolute paths without writing", async () => {
    const root = await project()
    expect(await resolveInsideProject(root, "../../etc/hosts")).toBeUndefined()
    expect(await resolveInsideProject(root, "/etc/hosts")).toBeUndefined()
    expect(await applyDiagnosticRecipe(root, diagnostic("../../etc/hosts"))).toEqual([])
  })

  test("allows a normal project-relative fixer path", async () => {
    const root = await project()
    await writeFile(join(root, "security.ts"), "if (token === expected) return true\n")
    expect(await applyDiagnosticRecipe(root, diagnostic("security.ts"))).toEqual(["security.ts"])
    expect(await readFile(join(root, "security.ts"), "utf8")).toContain("timingSafeEqual")
  })

  test("rejects a symlink whose target leaves the project", async () => {
    const root = await project()
    const outside = await mkdtemp(join(tmpdir(), "nifra-outside-"))
    roots.push(outside)
    await writeFile(join(outside, "security.ts"), "if (token === expected) return true\n")
    await symlink(join(outside, "security.ts"), join(root, "security.ts"))
    expect(await resolveInsideProject(root, "security.ts")).toBeUndefined()
    expect(await applyDiagnosticRecipe(root, diagnostic("security.ts"))).toEqual([])
  })

  // A workspace link points OUTSIDE the project by definition - that escape is exactly what lets its
  // artifact go stale - so the rebuild resolves it on purpose from the package NAME, under the rules in
  // workspace-link.ts, and refuses out loud rather than returning "changed nothing".
  test("rebuilds a workspace-linked package that lives outside the project", async () => {
    const root = await project()
    const outside = await linkedPackage({ build: "echo built > built.txt" })
    await linkInto(root, outside)
    expect(await applyDiagnosticRecipe(root, workspaceDiagnostic("@scope/pkg"))).toEqual([
      "@scope/pkg",
    ])
    expect(await readFile(join(outside, "built.txt"), "utf8")).toContain("built")
  })

  test("refuses, with the reason, when the linked package declares no build script", async () => {
    const root = await project()
    const outside = await linkedPackage(undefined)
    await linkInto(root, outside)
    await expect(applyDiagnosticRecipe(root, workspaceDiagnostic("@scope/pkg"))).rejects.toThrow(
      /declares no "build" script/,
    )
  })

  test("refuses to rebuild a registry install, which cannot be stale", async () => {
    const root = await project()
    const installed = join(root, "node_modules", "@scope", "pkg")
    await mkdir(installed, { recursive: true })
    await writeFile(
      join(installed, "package.json"),
      JSON.stringify({ name: "@scope/pkg", version: "1.0.0", scripts: { build: "exit 1" } }),
    )
    await expect(applyDiagnosticRecipe(root, workspaceDiagnostic("@scope/pkg"))).rejects.toThrow(
      /registry install/,
    )
  })

  test("refuses a package name that could climb out of node_modules", async () => {
    const root = await project()
    await expect(applyDiagnosticRecipe(root, workspaceDiagnostic("../../etc"))).rejects.toThrow(
      /not a package name/,
    )
  })

  test("surfaces the package's own build failure instead of reporting success", async () => {
    const root = await project()
    const outside = await linkedPackage({ build: "echo boom 1>&2; exit 3" })
    await linkInto(root, outside)
    await expect(applyDiagnosticRecipe(root, workspaceDiagnostic("@scope/pkg"))).rejects.toThrow(
      /`bun run build` failed/,
    )
  })
})
