/**
 * vinxi@0.5.x expects Vite 8 manifests at router base; Vite 8 still emits
 * `.vite/manifest.json` (same as 5–7). Patch once after install when vite 8 is present.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

const appRoot = process.cwd()
const require = createRequire(join(appRoot, "package.json"))
const viteMajor = require("vite/package.json").version.split(".")[0]
if (viteMajor !== "8") {
  process.exit(0)
}

const manifestPath = join(appRoot, "node_modules/vinxi/lib/manifest-path.js")
const src = readFileSync(manifestPath, "utf8")
if (src.includes('startsWith("8")')) {
  process.exit(0)
}

const next = src.replace(
  'vite.version.startsWith("7")',
  'vite.version.startsWith("7") ||\n\t\tvite.version.startsWith("8")',
)
if (next === src) {
  console.error("patch-vinxi-vite8: unexpected vinxi manifest-path.js layout")
  process.exit(1)
}
writeFileSync(manifestPath, next)
console.log("patched vinxi manifest path for Vite 8")
