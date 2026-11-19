import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { isRecord } from "./is-record.ts"
import { median, roundOrder } from "./rounds.ts"

const root = resolve(import.meta.dir, "..")
const cwd = await mkdtemp(join(tmpdir(), "nifra-bench-check-"))
const server = 'import { server } from "@nifrajs/core/server"'
const groups = 20
const perGroup = 20

function merge(modules: readonly string[], name: string): string {
  const imports = modules.map(
    (module, index) => `import { routes as r${index} } from "./${module}"`,
  )
  const calls = modules.map((_, index) => `  .merge(r${index})`)
  return [server, ...imports, `export const ${name} = server()`, ...calls, ""].join("\n")
}

function route(index: number, label = "first"): string {
  return `${server}
import { t } from "@nifrajs/schema"
export const routes = server().get("/items/r${index}/:id", {
  query: t.object({ q: t.optional(t.string()) }),
}, (c) => ({ id: c.params.id, q: c.query.q, label: "${label}" }))
`
}

const modes = ["full", "incremental"] as const
type Mode = (typeof modes)[number]

async function check(mode: Mode) {
  const cmd = [
    process.execPath,
    resolve(root, "packages/cli/src/cli.ts"),
    "check",
    "--json",
    "--timings",
    ...(mode === "incremental" ? ["--incremental"] : []),
  ]
  const started = performance.now()
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const elapsed = performance.now() - started
  assert.equal(code, 0, stderr || stdout)
  const result: unknown = JSON.parse(stdout)
  assert.ok(isRecord(result) && result.typecheck === "pass" && Array.isArray(result.diagnostics))
  const diagnostics = result.diagnostics.filter(
    (entry: unknown) => !isRecord(entry) || entry.code !== "NF-C010",
  )
  return { elapsed, diagnostics }
}

try {
  const starter = resolve(root, "packages/create-nifra/template")
  await symlink(resolve(root, "node_modules"), join(cwd, "node_modules"), "dir")
  await Bun.write(join(cwd, "package.json"), Bun.file(join(starter, "package.json")))
  await Bun.write(join(cwd, "tsconfig.json"), Bun.file(join(starter, "tsconfig.json")))
  const backend = join(cwd, "backend")
  await mkdir(backend)
  const mounts: string[] = []
  for (let group = 0; group < groups; group++) {
    const modules = Array.from(
      { length: perGroup },
      (_, index) => `r${group * perGroup + index}.ts`,
    )
    await Promise.all(
      modules.map((file, index) => writeFile(join(backend, file), route(group * perGroup + index))),
    )
    const mount = `group${group}.ts`
    await writeFile(join(backend, mount), merge(modules, "routes"))
    mounts.push(mount)
  }
  await writeFile(join(backend, "app.ts"), merge(mounts, "backend"))
  await check("incremental")
  const samples = { full: [] as number[], incremental: [] as number[] }
  const rounds = 20
  for (let round = 0; round < rounds; round++) {
    await writeFile(join(backend, "r0.ts"), route(0, `revision ${round}`))
    const diagnostics = []
    for (const mode of roundOrder(modes, round)) {
      const result = await check(mode)
      samples[mode].push(result.elapsed)
      diagnostics.push(result.diagnostics)
    }
    assert.deepEqual(diagnostics[0], diagnostics[1])
  }
  console.log(`${groups * perGroup} routes, ${rounds} paired handler edits, Bun ${Bun.version}`)
  for (const mode of modes) {
    const sorted = samples[mode].sort((a, b) => a - b)
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0
    console.log(`${mode}: median ${median(sorted).toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`)
  }
} finally {
  await rm(cwd, { recursive: true, force: true })
}
