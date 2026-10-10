#!/usr/bin/env bun
/** Keep the public package count in README synchronized with package manifests. */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { publishedPackageCount } from "./public-package-manifest.ts"

const ROOT = resolve(import.meta.dir, "..")
const PACKAGE_HEADING = /^(## Batteries \()\d+( packages, all typed, all optional\))$/m

export function renderPublicProductReadme(source: string, count: number): string {
  if (!PACKAGE_HEADING.test(source)) {
    throw new Error("README.md is missing the generated Batteries package-count heading")
  }
  return source.replace(PACKAGE_HEADING, `$1${count}$2`)
}

export function run(argv: readonly string[] = process.argv, root: string = ROOT): number {
  const readme = resolve(root, "README.md")
  const current = readFileSync(readme, "utf8")
  const expected = renderPublicProductReadme(current, publishedPackageCount(root))
  if (argv.includes("--check")) {
    if (current !== expected) {
      console.error("✗ README.md package count is stale - run `bun run gen:public`")
      return 1
    }
    console.log("✓ README.md package count matches published package manifests")
    return 0
  }
  if (current !== expected) writeFileSync(readme, expected)
  console.log("✓ README.md package count generated from published package manifests")
  return 0
}

if (import.meta.main) process.exit(run())
