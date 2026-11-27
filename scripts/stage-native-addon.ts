/**
 * Copy a freshly built `nifra-napi` shared library into `packages/node-engine/prebuilds/<platform>-<arch>[-libc]/nifra_napi.node`
 * for local testing or CI matrix artifact packaging.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function detectLibc(): string {
  if (process.platform !== "linux") return ""
  const report = process.report?.getReport()
  if (typeof report === "object" && report !== null && "header" in report) {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: narrowed Node diagnostic report object
    const header = (report as { readonly header?: { readonly glibcVersionRuntime?: string } })
      .header
    if (header?.glibcVersionRuntime !== undefined) return "-gnu"
  }
  return existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1")
    ? "-musl"
    : "-gnu"
}

const library =
  process.platform === "win32"
    ? "nifra_napi.dll"
    : process.platform === "darwin"
      ? "libnifra_napi.dylib"
      : "libnifra_napi.so"
const profile = process.argv.includes("--debug") ? "debug" : "release"
const source = join(ROOT, "native", "nifra-engine", "target", profile, library)
if (!existsSync(source)) {
  throw new Error(`Missing built native library at ${source}`)
}

const tag = `${process.platform}-${process.arch}${detectLibc()}`
const destDir = join(ROOT, "packages", "node-engine", "prebuilds", tag)
const destFile = join(destDir, "nifra_napi.node")
mkdirSync(destDir, { recursive: true })
copyFileSync(source, destFile)
console.log(`Staged ${destFile} from ${source}`)
