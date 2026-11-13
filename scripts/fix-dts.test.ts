import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const repoRoot = dirname(import.meta.dir)
const tscEntry = Bun.fileURLToPath(import.meta.resolve("typescript")).replace(
  /typescript\.js$/,
  "tsc.js",
)

const run = async (args: string[], cwd: string): Promise<void> => {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, `${args.join(" ")}\n${stdout}\n${stderr}`).toBe(0)
}

test("the publish emit strips runtime comments but retains declaration JSDoc", async () => {
  const root = await mkdtemp(join(tmpdir(), "fix-dts-"))
  try {
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(
      join(root, "tsconfig.build.json"),
      JSON.stringify({
        extends: join(repoRoot, "tsconfig.build.base.json"),
        compilerOptions: { outDir: "dist", rootDir: "src", types: [] },
        include: ["src/**/*"],
      }),
    )
    await writeFile(
      join(root, "src/index.ts"),
      "/** Public declaration docs must survive the publish build. */\n// runtime comment must not ship\nexport const answer = 42\n",
    )

    await run(["node", tscEntry, "-p", "tsconfig.build.json", "--incremental", "false"], root)
    await run([process.execPath, "run", join(repoRoot, "scripts/fix-dts.ts"), "dist"], root)

    const javascript = await readFile(join(root, "dist/index.js"), "utf8")
    const declaration = await readFile(join(root, "dist/index.d.ts"), "utf8")
    expect(javascript).not.toContain("runtime comment must not ship")
    expect(declaration).toContain("Public declaration docs must survive the publish build.")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
