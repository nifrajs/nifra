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

  test("does not rebuild a workspace package symlinked outside the project", async () => {
    const root = await project()
    const outside = await mkdtemp(join(tmpdir(), "nifra-package-"))
    roots.push(outside)
    await mkdir(join(outside, "@scope", "pkg"), { recursive: true })
    await writeFile(join(outside, "@scope", "pkg", "package.json"), '{"name":"@scope/pkg"}\n')
    await symlink(outside, join(root, "node_modules"), "dir")
    expect(await applyDiagnosticRecipe(root, workspaceDiagnostic("@scope/pkg"))).toEqual([])
  })
})
