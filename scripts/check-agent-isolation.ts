import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { findAgentBoundaryFailures } from "./check-agent-boundary.ts"

const ROOT = resolve(import.meta.dir, "..")
const PROTECTED = ["core", "client", "web", "schema"] as const
const OPTIONAL = ["agent-protocol", "pi", "coding-agent"] as const

interface PackageMetric {
  readonly package: string
  readonly distBytes: number | null
  readonly sourceBytes: number
}

const failures = await findAgentBoundaryFailures(ROOT)
if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}

async function directoryBytes(directory: string): Promise<number> {
  if (!existsSync(directory)) return 0
  let total = 0
  for await (const path of new Bun.Glob("**/*").scan({ cwd: directory, dot: false })) {
    const file = Bun.file(resolve(directory, path))
    if (await file.exists()) total += file.size
  }
  return total
}

const metrics: PackageMetric[] = []
for (const packageName of [...PROTECTED, ...OPTIONAL]) {
  const packageRoot = resolve(ROOT, "packages", packageName)
  metrics.push({
    package: packageName,
    distBytes: existsSync(resolve(packageRoot, "dist"))
      ? await directoryBytes(resolve(packageRoot, "dist"))
      : null,
    sourceBytes: await directoryBytes(resolve(packageRoot, "src")),
  })
}

const result = {
  generatedAt: new Date().toISOString(),
  boundary: "passed",
  protected: metrics.filter((metric) => (PROTECTED as readonly string[]).includes(metric.package)),
  optional: metrics.filter((metric) => (OPTIONAL as readonly string[]).includes(metric.package)),
  note: "Run after build to track dist size. Agent packages are optional and are not included in protected package metrics or app dependency paths.",
}
if (Bun.argv.includes("--json")) console.log(JSON.stringify(result))
else {
  for (const metric of metrics)
    console.log(
      `${metric.package}: source=${metric.sourceBytes}B dist=${metric.distBytes === null ? "not-built" : `${metric.distBytes}B`}`,
    )
  console.log("✓ agent isolation: protected package boundary passed")
}
