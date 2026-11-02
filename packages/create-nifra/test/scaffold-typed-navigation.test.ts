import { afterAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import ts from "typescript"
import { scaffold } from "../src/cli.ts"
import { FRAMEWORK_IDS } from "../src/scaffold/frameworks.ts"
import { materializeAll } from "./_scaffold-fixtures.ts"

// A fresh scaffold ships a route table, so a link to a route it does not have is a compile error from the
// first commit: `navigate("/nope")` (a string) and `navigate(href({ to: "/nope" }))` (an unknown route)
// both fail, while a route the starter has still compiles and so does every file it came with.

const REPO = resolve(import.meta.dir, "../../..")

const { scaffolds, cleanup } = await materializeAll()
const isrRoot = await mkdtemp(join(tmpdir(), "nifra-typed-nav-"))
afterAll(async () => {
  await cleanup()
  await rm(isrRoot, { recursive: true, force: true })
})

// The workspace packages as source, the way the repository's own programs resolve them.
const rootConfig = ts.readConfigFile(join(REPO, "tsconfig.json"), ts.sys.readFile)
const rootOptions = ts.parseJsonConfigFileContent(rootConfig.config, ts.sys, REPO).options

// A package the shared install does not carry (the framework runtime, a database driver): the packed
// cold-start gate resolves those in an external consumer. Every other diagnostic counts.
const UNINSTALLED = new Set([2307, 7016])

const PROBE = `import { href, useNavigate } from "@nifrajs/web-FRAMEWORK/router"

export function probe(): void {
  const navigate = useNavigate()
  navigate(href({ to: "/" }))
  navigate("/nope")
  navigate(href({ to: "/nope" }))
}
`

/** The workspace's installed packages, root and examples (which carry the framework runtimes), as the scaffold's own. */
async function linkInstalled(dir: string): Promise<void> {
  const target = join(dir, "node_modules")
  await mkdir(join(target, "@types"), { recursive: true })
  for (const base of [join(REPO, "examples/node_modules"), join(REPO, "node_modules")]) {
    for (const scope of ["", "@types"]) {
      if (!existsSync(join(base, scope))) continue
      for (const entry of await readdir(join(base, scope))) {
        const link = join(target, scope, entry)
        if (entry.startsWith(".") || (scope === "" && entry === "@types") || existsSync(link))
          continue
        await symlink(join(base, scope, entry), link)
      }
    }
  }
}

async function diagnosticsOf(dir: string, framework: string): Promise<string[]> {
  await linkInstalled(dir)
  await writeFile(join(dir, "nav-probe.ts"), PROBE.replace("FRAMEWORK", framework))
  const config = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir)
  const options: ts.CompilerOptions = {
    ...parsed.options,
    ...(rootOptions.paths === undefined ? {} : { paths: rootOptions.paths }),
    pathsBasePath: REPO,
  }
  const files = [
    ...parsed.fileNames.filter((file) => !file.endsWith("nav-probe.ts")),
    join(dir, "nav-probe.ts"),
  ]
  const program = ts.createProgram(files, options)
  return ts
    .getPreEmitDiagnostics(program)
    .filter((item) => {
      if (item.file === undefined) return false
      // Another drive (the repository's, on Windows) makes `relative` answer with an absolute path.
      const inside = relative(dir, item.file.fileName)
      return !inside.startsWith("..") && !isAbsolute(inside)
    })
    .filter((item) => !UNINSTALLED.has(item.code))
    .map((item) => {
      const where = item.file?.getLineAndCharacterOfPosition(item.start ?? 0)
      return `${relative(dir, item.file?.fileName ?? "")}:${(where?.line ?? 0) + 1} TS${item.code}`
    })
}

for (const framework of FRAMEWORK_IDS) {
  test(`site-${framework}: navigate takes an Href of a route the app has`, async () => {
    const dir = scaffolds.find((s) => s.label === `site-${framework}`)?.dir
    if (dir === undefined) throw new Error(`no site-${framework} scaffold`)
    // The two refused lines of the probe, and nothing else in the scaffold.
    expect(await diagnosticsOf(dir, framework)).toEqual([
      expect.stringMatching(/^nav-probe\.ts:6 TS\d+$/),
      expect.stringMatching(/^nav-probe\.ts:7 TS\d+$/),
    ])
  }, 120_000)
}

test("isr: navigate takes an Href of a route the app has", async () => {
  const dir = join(isrRoot, "isr")
  await scaffold({ target: dir, template: "isr" })
  expect(await diagnosticsOf(dir, "react")).toEqual([
    expect.stringMatching(/^nav-probe\.ts:6 TS\d+$/),
    expect.stringMatching(/^nav-probe\.ts:7 TS\d+$/),
  ])
}, 120_000)
