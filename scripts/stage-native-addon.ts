/**
 * Copy a freshly built `nifra-napi` shared library into either:
 *   - `packages/node-engine/prebuilds/<tag>/nifra_napi.node` (default, local fallback), or
 *   - `packages/node-engine-<tag>/nifra_napi.node` (when `--package` is passed).
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  return idx === -1 ? undefined : process.argv[idx + 1]
}

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

const targetTriple = argValue("--target")
const explicitTag = argValue("--tag")
const library =
  explicitTag?.startsWith("win32") ||
  targetTriple?.includes("windows") ||
  process.platform === "win32"
    ? "nifra_napi.dll"
    : explicitTag?.startsWith("darwin") ||
        targetTriple?.includes("apple-darwin") ||
        (explicitTag === undefined && process.platform === "darwin")
      ? "libnifra_napi.dylib"
      : "libnifra_napi.so"
const profile = process.argv.includes("--debug") ? "debug" : "release"
const source =
  targetTriple !== undefined
    ? join(ROOT, "native", "nifra-engine", "target", targetTriple, profile, library)
    : join(ROOT, "native", "nifra-engine", "target", profile, library)
if (!existsSync(source)) {
  throw new Error(`Missing built native library at ${source}`)
}

const tag = explicitTag ?? `${process.platform}-${process.arch}${detectLibc()}`
const destDir = process.argv.includes("--package")
  ? join(ROOT, "packages", `node-engine-${tag}`)
  : join(ROOT, "packages", "node-engine", "prebuilds", tag)
const destFile = join(destDir, "nifra_napi.node")
mkdirSync(destDir, { recursive: true })
copyFileSync(source, destFile)
console.log(`Staged ${destFile} from ${source}`)
