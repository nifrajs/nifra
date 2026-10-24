import { afterAll, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { LOCAL_CLI_ENV } from "../src/local-cli.ts"

// A global or `bun link`ed CLI run against a project that installs its own: the project commands run
// through the project's copy, even at the same version, or warn naming both copies of core.

const CLI = resolve(import.meta.dir, "../src/cli.ts")
const VERSION = "5.6.0"
const grounds: string[] = []
afterAll(async () => {
  await Promise.all(grounds.map((dir) => rm(dir, { recursive: true, force: true })))
})

const FAKE_CLI = `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), local: process.env.${LOCAL_CLI_ENV} ?? "" }))\n`

async function project(over: { readonly cli: boolean }): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nifra-local-cli-")))
  grounds.push(dir)
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }))
  const core = join(dir, "node_modules", "@nifrajs", "core")
  await mkdir(core, { recursive: true })
  await writeFile(
    join(core, "package.json"),
    JSON.stringify({ name: "@nifrajs/core", version: VERSION }),
  )
  if (over.cli) {
    const pkg = join(dir, "node_modules", "@nifrajs", "cli")
    await mkdir(join(pkg, "dist"), { recursive: true })
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@nifrajs/cli", version: VERSION, bin: { nifra: "dist/cli.js" } }),
    )
    await writeFile(join(pkg, "dist", "cli.js"), FAKE_CLI)
    await chmod(join(pkg, "dist", "cli.js"), 0o755)
  }
  return dir
}

async function run(
  cwd: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    env: { ...process.env, [LOCAL_CLI_ENV]: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exit }
}

test("a project command runs through the project's CLI at the same version, args intact", async () => {
  const dir = await project({ cli: true })
  const out = await run(dir, ["check", "--json"])
  expect(out.exit).toBe(0)
  expect(JSON.parse(out.stdout)).toEqual({ args: ["check", "--json"], local: "0" })
  expect(out.stderr).toContain("is not the project's; running its @nifrajs/cli 5.6.0 from")
  expect(out.stderr).toContain(join(dir, "node_modules", "@nifrajs", "cli"))
})

test(`${LOCAL_CLI_ENV}=0 runs this CLI, which names both copies of core`, async () => {
  const dir = await project({ cli: true })
  const out = await run(dir, ["check"], { [LOCAL_CLI_ENV]: "0" })
  expect(out.stdout).not.toContain('"args"')
  expect(out.stderr).toContain(
    `runs its own @nifrajs/core from ${resolve(import.meta.dir, "../../core")}, and the project resolves ${join(dir, "node_modules", "@nifrajs", "core")}`,
  )
})

test("without a project CLI the command runs here and warns", async () => {
  const dir = await project({ cli: false })
  const out = await run(dir, ["check"])
  expect(out.stderr).toContain("the app loads both, and `nifra check` cannot see this CLI's copy")
  expect(out.stderr).not.toContain("is not the project's")
})

test("commands that do not run the project stay here", async () => {
  const dir = await project({ cli: true })
  const out = await run(dir, ["--version"])
  expect(out.stdout.trim()).toBe(`nifra (@nifrajs/cli) ${VERSION}`)
})
