/**
 * Source-level guard for the public/private seam.
 *
 * Packaging checks catch dependency and manifest leaks; this gate catches a runtime-only import in a
 * seam that has to stay edge-portable, and a seam that quietly stopped being reachable from its
 * package's `exports`.
 *
 * What this file deliberately does NOT contain is the list of private names to scan for. Writing
 * them here would put the thing being protected into the repository being protected - the guard
 * would become the leak. `PRIVATE_MARKERS` supplies them at runtime instead (comma-separated, from a
 * developer's local environment or a CI secret), so the check is enforceable everywhere and legible
 * nowhere. With the variable unset the marker scan is skipped and the structural checks still run.
 */

import { publishedPackages } from "./public-package-manifest.ts"

const failures: string[] = []
const publicPackageDirs = publishedPackages().map((pkg) => `packages/${pkg.dir}`)
const SKIP = /(?:^|\/)(?:dist|node_modules|coverage)\//

const markers = (process.env.PRIVATE_MARKERS ?? "")
  .split(",")
  .map((marker) => marker.trim())
  .filter((marker) => marker.length > 0)

for (const marker of markers) {
  for (const dir of publicPackageDirs) {
    for (const file of new Bun.Glob("**/*").scanSync(dir)) {
      if (SKIP.test(file) || !/\.(?:ts|tsx|js|jsx|md|mdx|json)$/.test(file)) continue
      const text = await Bun.file(`${dir}/${file}`).text()
      // Case-insensitive substring: a private name is a name, not a pattern, and the reader of this
      // failure already knows which one they typed.
      if (text.toLowerCase().includes(marker.toLowerCase())) {
        failures.push(`${dir}/${file}: private marker present`)
      }
    }
  }
}

const exportsOf = async (path: string): Promise<Record<string, unknown>> => {
  const manifest = JSON.parse(await Bun.file(path).text()) as { exports?: Record<string, unknown> }
  return manifest.exports ?? {}
}
const coreExports = await exportsOf("packages/core/package.json")
const imageExports = await exportsOf("packages/image/package.json")
for (const [path, exportsMap, name] of [
  ["./channel", coreExports, "@nifrajs/core"],
  ["./data", coreExports, "@nifrajs/core"],
  ["./range", coreExports, "@nifrajs/core"],
  ["./og", imageExports, "@nifrajs/image"],
] as const) {
  if (!(path in exportsMap)) failures.push(`${name}: missing public export ${path}`)
}

// These seams are the ones a private adapter imports from an edge or browser bundle, so a runtime
// builtin here is a portability break rather than a style preference.
for (const file of [
  "packages/core/src/channel.ts",
  "packages/core/src/data.ts",
  "packages/core/src/range.ts",
  "packages/image/src/og.ts",
]) {
  const source = await Bun.file(file).text()
  if (/\bfrom\s+["'](?:node|bun):/.test(source)) {
    failures.push(`${file}: edge seam imports a runtime-specific builtin`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}
const scanned = markers.length === 0 ? "marker scan skipped (PRIVATE_MARKERS unset)" : "no markers"
console.log(`✓ public boundary: ${publicPackageDirs.length} packages, ${scanned}, seams exported`)
