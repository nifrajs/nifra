import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isJsonRecord, readJsonRecord } from "./read-json.ts"

interface VersionedRow {
  readonly name?: unknown
  readonly version?: unknown
  readonly nifra?: unknown
  readonly you?: unknown
}

function versionRows(value: unknown): VersionedRow[] {
  return Array.isArray(value) ? value.filter(isJsonRecord) : []
}

function tableRows(value: unknown): VersionedRow[] {
  return Array.isArray(value)
    ? value.flatMap((table) => (isJsonRecord(table) ? versionRows(table.rows) : []))
    : []
}

export function checkPublicReleaseFreshness(root = process.cwd()): string[] {
  const failures: string[] = []
  const core = readJsonRecord(join(root, "packages/core/package.json"))
  const expected = typeof core.version === "string" ? core.version : undefined
  const manifest = readJsonRecord(join(root, "server.json"))
  const benchmarks = readJsonRecord(join(root, "site/shared/data/benchmarks.json"))
  const frameworksDemo = readJsonRecord(join(root, "site/shared/data/frameworks-demo.json"))

  if (expected === undefined) failures.push("packages/core/package.json has no version")
  if (manifest.version !== expected) {
    failures.push(
      `server.json is ${String(manifest.version)}, but @nifrajs/core is ${String(expected)}`,
    )
  }
  if (frameworksDemo.nifraVersion !== expected) {
    failures.push(
      `site/shared/data/frameworks-demo.json was generated for ${String(frameworksDemo.nifraVersion)}, expected ${String(expected)}; run \`bun run site/build-frameworks.ts\``,
    )
  }
  for (const file of ["site/routes/docs/cli.tsx", "site/routes/docs/migrate-5.tsx"] as const) {
    const source = readFileSync(join(root, file), "utf8")
    const docVersion = /const NIFRA_VERSION\s*=\s*"([^"]+)"/.exec(source)?.[1]
    if (docVersion !== expected) {
      failures.push(
        `${file} uses Nifra ${String(docVersion)}, expected ${String(expected)}; sync it with \`scripts/version.ts\``,
      )
    }
  }
  const bugTemplate = readFileSync(join(root, ".github/ISSUE_TEMPLATE/bug_report.yml"), "utf8")
  const bugTemplateVersion =
    /id: version\s+attributes:[\s\S]*?placeholder:\s*"(\d+\.\d+\.\d+)"/.exec(bugTemplate)?.[1]
  if (bugTemplateVersion !== expected) {
    failures.push(
      `.github/ISSUE_TEMPLATE/bug_report.yml suggests Nifra ${String(bugTemplateVersion)}, expected ${String(expected)}; sync it with scripts/version.ts`,
    )
  }

  if (expected !== undefined) {
    const slices: Array<[string, unknown]> = [
      ["heroSsr", benchmarks.heroSsr],
      ["frontend", benchmarks.frontend],
      ["http", benchmarks.http],
      ["bundle", benchmarks.bundle],
      ["httpWorkloads", tableRows(benchmarks.httpWorkloads)],
      ["httpRealworld", tableRows(benchmarks.httpRealworld)],
      ["ssrTables", tableRows(benchmarks.ssrTables)],
      ["ssrTablesB", tableRows(benchmarks.ssrTablesB)],
      [
        "httpMemory",
        isJsonRecord(benchmarks.httpMemory)
          ? Object.entries(benchmarks.httpMemory).flatMap(([runtime, capture]) =>
              isJsonRecord(capture)
                ? versionRows(capture.rows).map((row) => ({
                    ...row,
                    name: `${runtime}/${String(row.name)}`,
                  }))
                : [],
            )
          : [],
      ],
    ]

    let checked = 0
    for (const [slice, value] of slices) {
      for (const [index, row] of versionRows(value).entries()) {
        if (row.nifra !== true && row.you !== true) continue
        checked += 1
        if (row.version !== expected) {
          failures.push(
            `site/shared/data/benchmarks.json ${slice}[${index}] ${String(row.name)} is ${String(row.version)}, expected ${expected}; refresh it with \`bun run bench:site:update\``,
          )
        }
      }
    }
    if (checked === 0) failures.push("benchmark dataset contains no Nifra versioned rows")
  }

  for (const key of ["ssrCaptured", "httpWorkloadsCaptured", "httpRealworldCaptured"] as const) {
    const capture = benchmarks[key]
    if (
      !isJsonRecord(capture) ||
      typeof capture.date !== "string" ||
      typeof capture.source !== "string" ||
      typeof capture.sourceUrl !== "string" ||
      capture.nifraVersion !== expected
    ) {
      failures.push(
        `site/shared/data/benchmarks.json ${key} must include its source, capture date, and nifraVersion ${String(expected)}`,
      )
    }
  }

  return failures
}

if (import.meta.main) {
  const failures = checkPublicReleaseFreshness()
  if (failures.length > 0) {
    console.error("✗ public release data is stale:")
    for (const failure of failures) console.error(`  ${failure}`)
    console.error(
      "Run `bun run bench:site:update` after `bun run release:prepare`, then commit the measured data.",
    )
    process.exitCode = 1
  } else {
    console.log(
      "✓ MCP manifest, docs, issue template, demo, and public benchmark captures match the core release version",
    )
  }
}
