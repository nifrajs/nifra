#!/usr/bin/env bun
/** Keep the public package count in README and the site proof tile synchronized with package manifests. */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { publishedPackageCount } from "./public-package-manifest.ts"

const ROOT = resolve(import.meta.dir, "..")
const PACKAGE_HEADING = /^(## Batteries \()\d+( packages, all typed, all optional\))$/m
const BENCHMARKS = "site/shared/data/benchmarks.json"
const PACKAGE_TILE = /("value": ")\d+(",\s*"label": "typed packages, all optional")/

export function renderPublicProductReadme(source: string, count: number): string {
  if (!PACKAGE_HEADING.test(source)) {
    throw new Error("README.md is missing the generated Batteries package-count heading")
  }
  return source.replace(PACKAGE_HEADING, `$1${count}$2`)
}

export function renderPackageTile(source: string, count: number): string {
  if (!PACKAGE_TILE.test(source)) {
    throw new Error(`${BENCHMARKS} is missing the generated typed-packages proof tile`)
  }
  return source.replace(PACKAGE_TILE, `$1${count}$2`)
}

export function run(argv: readonly string[] = process.argv, root: string = ROOT): number {
  const count = publishedPackageCount(root)
  const targets = [
    { path: "README.md", render: renderPublicProductReadme, label: "README.md package count" },
    ...(existsSync(resolve(root, BENCHMARKS))
      ? [{ path: BENCHMARKS, render: renderPackageTile, label: "site package-count tile" }]
      : []),
  ]
  const stale = targets.flatMap((target) => {
    const file = resolve(root, target.path)
    const current = readFileSync(file, "utf8")
    const expected = target.render(current, count)
    return current === expected ? [] : [{ ...target, file, expected }]
  })
  if (argv.includes("--check")) {
    if (stale.length > 0) {
      for (const target of stale) {
        console.error(`✗ ${target.label} is stale - run \`bun run gen:public\``)
      }
      return 1
    }
    console.log("✓ README.md and site package counts match published package manifests")
    return 0
  }
  for (const target of stale) writeFileSync(target.file, target.expected)
  console.log("✓ README.md and site package counts generated from published package manifests")
  return 0
}

if (import.meta.main) process.exit(run())
