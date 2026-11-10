import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs, run } from "../src/cli.ts"
import { scaffold } from "../src/scaffold/project.ts"
import { SHELL_FEATURE, TAURI_CLI_VERSION } from "../src/scaffold/shell.ts"
import { LIB_RS, resolveShellSpec, shellFiles } from "../src/shell-files.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const fresh = (name: string): string => {
  const root = mkdtempSync(join(tmpdir(), "create-nifra-shell-"))
  dirs.push(root)
  return join(root, name)
}
const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8")

test("--shell tauri scaffolds the shell project, the server's CORS for it and the scripts", async () => {
  const dir = fresh("todo-app")
  const result = await scaffold({ target: dir, template: "site", shell: "tauri" })
  expect(result.shell).toBe("tauri")
  for (const [path] of shellFiles(resolveShellSpec({ packageName: "todo-app" }))) {
    expect(existsSync(join(dir, path))).toBe(true)
  }
  expect(read(dir, "src-tauri/Cargo.toml")).toContain('name = "todo-app"')
  expect(read(dir, "src-tauri/src/lib.rs")).toBe(LIB_RS)
  const framework = read(dir, "backend/framework.ts")
  expect(framework).toContain('import { SHELL_ORIGINS } from "./shell-origins"')
  expect(framework).toContain("export const use = ")
  expect(framework).toContain('"x-nifra-redirect","x-nifra-status","x-nifra-revalidate"')
  expect(read(dir, "backend/app.ts")).not.toContain("SHELL_ORIGINS")
  const index = read(dir, "routes/index.backend.ts")
  expect(index).toContain('import { SHELL_ORIGINS } from "../backend/shell-origins"')
  expect(index).toContain("sameOrigin || (origin !== null && SHELL_ORIGINS.includes(origin))")
  expect(read(dir, "backend/shell-origins.ts")).toContain('"tauri://localhost"')
  const pkg = JSON.parse(read(dir, "package.json"))
  expect(pkg.devDependencies["@tauri-apps/cli"]).toBe(TAURI_CLI_VERSION)
  expect(pkg.scripts["shell:dev"]).toBe("tauri dev")
  expect(pkg.scripts["shell:build"]).toBe("tauri build")
  expect(read(dir, ".gitignore")).toContain("dist-shell/")
})

test("every framework's site template takes the shell", async () => {
  for (const framework of ["react", "preact", "vue", "solid", "svelte"]) {
    const dir = fresh(`app-${framework}`)
    await scaffold({ target: dir, template: "site", framework, shell: "tauri" })
    expect(read(dir, "backend/framework.ts")).toContain("export const use = ")
  }
})

test("a scaffold without --shell has none of it", async () => {
  const dir = fresh("plain")
  await scaffold({ target: dir, template: "site" })
  expect(existsSync(join(dir, "src-tauri"))).toBe(false)
  expect(read(dir, "backend/framework.ts")).not.toContain("SHELL_ORIGINS")
  expect(read(dir, "routes/index.backend.ts")).not.toContain("allowedOrigins")
  expect(read(dir, ".gitignore")).not.toContain("dist-shell")
  expect(JSON.parse(read(dir, "package.json")).scripts["shell:dev"]).toBeUndefined()
})

test("--shell needs the site template and a known shell", async () => {
  await expect(scaffold({ target: fresh("a"), template: "api", shell: "tauri" })).rejects.toThrow(
    "--shell requires the site template",
  )
  await expect(
    scaffold({ target: fresh("b"), template: "site", shell: "electron" }),
  ).rejects.toThrow('unknown --shell "electron". options: tauri')
})

test("--shell implies the site template and is reported", async () => {
  expect(parseArgs(["app", "--shell", "tauri"])).toMatchObject({ template: "site", shell: "tauri" })
  const dir = fresh("reported")
  const out = await run([dir, "--shell", "tauri"])
  expect(out.code).toBe(0)
  expect(out.message).toContain("Tauri shell")
  expect(out.message).toContain("bunx tauri icon")
})

test("the shell's package contribution declares what it adds", () => {
  expect(SHELL_FEATURE.replaces).toBeUndefined()
  expect(Object.keys(SHELL_FEATURE.scripts ?? {})).toEqual(["shell:dev", "shell:build"])
})
