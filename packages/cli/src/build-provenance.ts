import { createReadStream } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { Glob } from "bun"
import { codeUnitOrder } from "./internal/code-unit-order.ts"
import { isRecord } from "./internal/record.ts"

const PROJECT_SOURCE = new Glob(
  "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,jsonc,svelte,vue,md,mdx,css,lock,lockb,toml,yaml,yml}",
)
const PUBLIC_ASSET = new Glob("public/**/*")
const FILES = new Glob("**/*")
const IGNORED = /(^|\/)(node_modules|dist|build|\.nifra|\.git|\.wrangler|coverage)\//
const SHA256 = /^[a-f0-9]{64}$/

const posix = (path: string): string => (sep === "\\" ? path.replaceAll("\\", "/") : path)

function projectInputs(root: string, outDir: string, glob: Glob): string[] {
  const output = posix(relative(root, outDir))
  const inside =
    output !== "" && output !== ".." && !output.startsWith("../") && !isAbsolute(output)
  return [...glob.scanSync({ cwd: root })]
    .map(posix)
    .filter((path) => !IGNORED.test(path) && (!inside || !path.startsWith(`${output}/`)))
}

export function projectSourceFiles(root: string, outDir: string): string[] {
  return projectInputs(root, outDir, PROJECT_SOURCE).sort(codeUnitOrder)
}

export function buildOutputFiles(outDir: string): string[] {
  return [...FILES.scanSync({ cwd: outDir, dot: true })].map(posix).sort(codeUnitOrder)
}

export async function fingerprintFiles(root: string, paths: readonly string[]): Promise<string> {
  const manifest = new Bun.CryptoHasher("sha256")
  for (const path of paths) {
    const file = new Bun.CryptoHasher("sha256")
    for await (const chunk of createReadStream(resolve(root, path))) file.update(chunk)
    manifest.update(JSON.stringify([path, file.digest("hex")]))
  }
  return manifest.digest("hex")
}

export async function fingerprintBuildInputs(root: string, outDir: string): Promise<string> {
  const paths = new Set([
    ...projectSourceFiles(root, outDir),
    ...projectInputs(root, outDir, PUBLIC_ASSET),
  ])
  return fingerprintFiles(root, [...paths].sort(codeUnitOrder))
}

interface BuildProvenance {
  readonly version: 1
  readonly sourceDigest: string
  readonly buildDigest: string
}

function receiptPath(root: string, outDir: string): string {
  const key = Bun.CryptoHasher.hash("sha256", posix(relative(root, outDir)), "hex")
  return resolve(root, ".nifra", "build-provenance", `${key}.json`)
}

/** Record the completed build only if it read the same project inputs on both sides of the build. */
export async function recordBuildProvenance(
  root: string,
  outDir: string,
  before: string,
): Promise<boolean> {
  const buildDigest = await fingerprintFiles(outDir, buildOutputFiles(outDir))
  const sourceDigest = await fingerprintBuildInputs(root, outDir)
  if (sourceDigest !== before) return false
  const receipt: BuildProvenance = { version: 1, sourceDigest, buildDigest }
  const path = receiptPath(root, outDir)
  const staged = `${path}.${crypto.randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(staged, `${JSON.stringify(receipt)}\n`, { flag: "wx" })
    await rename(staged, path)
  } finally {
    await rm(staged, { force: true })
  }
  return true
}

export async function readBuildProvenance(
  root: string,
  outDir: string,
): Promise<BuildProvenance | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(receiptPath(root, outDir), "utf8"))
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      typeof parsed.sourceDigest === "string" &&
      SHA256.test(parsed.sourceDigest) &&
      typeof parsed.buildDigest === "string" &&
      SHA256.test(parsed.buildDigest)
    )
      return { version: 1, sourceDigest: parsed.sourceDigest, buildDigest: parsed.buildDigest }
  } catch (error) {
    // A missing or malformed receipt cannot certify any build.
    if (!(error instanceof SyntaxError) && Reflect.get(Object(error), "code") !== "ENOENT")
      throw error
  }
  return undefined
}
