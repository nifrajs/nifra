/**
 * Packs every public package and reads what the tarballs hold:
 *   - a LICENSE file, and no test file, key, environment file, log or private directory
 *     (`NEVER_SHIPPED`);
 *   - no private marker (`PRIVATE_MARKERS`, required under `RELEASE_MODE=1`) and no home-directory path;
 *   - npm selects the same files bun packed, since npm is what publishes;
 *   - under `RELEASE_MODE=1`, the file lists match `packed-files.json`, the record the release pull
 *     request carries, so every file added to or dropped from a package since the last release was
 *     in a reviewed diff. Outside release mode a difference is only reported.
 *
 *   bun run check:packed            check (needs a fresh `bun run build`)
 *   bun run check:packed --update   rewrite packed-files.json from the current packs
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { codeUnitOrder } from "./code-unit-order.ts"
import { staleDeclarations } from "./llms-corpus-check.ts"
import {
  contentFindings,
  describeDrift,
  fileListDrift,
  neverShipped,
  type PackedSnapshot,
  privateMarkers,
  readTarball,
  renderSnapshot,
  SNAPSHOT_FILE,
} from "./packed-contents.ts"
import { publishedPackages } from "./public-package-manifest.ts"

export interface PackedPackage {
  readonly name: string
  /** Relative to the root. */
  readonly dir: string
}

export interface PackedCheckOptions {
  readonly root: string
  readonly packages: readonly PackedPackage[]
  readonly markers: readonly string[]
  readonly release: boolean
  readonly update: boolean
  /** Compare bun's file selection with npm's; off only where npm cannot run. */
  readonly npm: boolean
  /** npm's file selection for a package directory, or why it could not be had. */
  readonly npmFiles?: (dir: string) => Promise<readonly string[] | string>
}

export interface PackedCheckResult {
  readonly failures: readonly string[]
  readonly notes: readonly string[]
  readonly snapshot: PackedSnapshot
  readonly fileCount: number
}

const NPM_CONCURRENCY = 8

async function npmFileList(dir: string): Promise<readonly string[] | string> {
  const child = Bun.spawn(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) return `npm pack --dry-run failed: ${stderr.trim().split("\n").at(-1) ?? ""}`
  const parsed: unknown = JSON.parse(stdout)
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined
  const files: unknown =
    typeof first === "object" && first !== null && "files" in first ? first.files : undefined
  if (!Array.isArray(files)) return "npm pack --dry-run printed no file list"
  return files.flatMap((file: unknown) =>
    typeof file === "object" && file !== null && "path" in file && typeof file.path === "string"
      ? [file.path]
      : [],
  )
}

async function npmParity(
  root: string,
  packages: readonly PackedPackage[],
  packed: PackedSnapshot,
  npmFiles: (dir: string) => Promise<readonly string[] | string>,
): Promise<string[]> {
  const failures: string[] = []
  const queue = packages.filter((pkg) => packed[pkg.name] !== undefined)
  const worker = async (): Promise<void> => {
    for (let pkg = queue.shift(); pkg !== undefined; pkg = queue.shift()) {
      const npm = await npmFiles(join(root, pkg.dir))
      if (typeof npm === "string") {
        failures.push(`${pkg.name}: ${npm}`)
        continue
      }
      const drift = describeDrift(
        `${pkg.name}: npm would publish a different file set than the one scanned`,
        fileListDrift(packed[pkg.name], npm),
      )
      if (drift !== undefined) failures.push(drift)
    }
  }
  await Promise.all(Array.from({ length: NPM_CONCURRENCY }, worker))
  return failures.sort(codeUnitOrder)
}

export async function checkPacked(options: PackedCheckOptions): Promise<PackedCheckResult> {
  const failures: string[] = []
  const notes: string[] = []
  if (options.release && options.markers.length === 0)
    failures.push("PRIVATE_MARKERS must be non-empty in release mode")
  if (options.markers.length === 0) notes.push("marker scan skipped (PRIVATE_MARKERS unset)")

  const snapshot: Record<string, readonly string[]> = {}
  let fileCount = 0
  const dest = mkdtempSync(join(tmpdir(), "nifra-check-packed-"))
  try {
    for (const pkg of options.packages) {
      const out = join(dest, pkg.dir.replaceAll("/", "_"))
      const packed = spawnSync(
        process.execPath,
        ["pm", "pack", "--destination", out, "--quiet", "--ignore-scripts"],
        { cwd: join(options.root, pkg.dir), encoding: "utf8" },
      )
      const tgz =
        packed.status === 0 && existsSync(out)
          ? readdirSync(out).find((file) => file.endsWith(".tgz"))
          : undefined
      if (tgz === undefined) {
        failures.push(`${pkg.name}: bun pm pack failed: ${(packed.stderr ?? "").trim()}`)
        continue
      }
      const files = readTarball(join(out, tgz))
      const paths = files.map((file) => file.path)
      snapshot[pkg.name] = paths
      fileCount += paths.length
      // Every package is MIT, and the license asks for its text in every copy.
      if (!paths.some((path) => /^licen[cs]e(?:\.|$)/i.test(path)))
        failures.push(`${pkg.name}: ships no LICENSE file`)
      for (const found of neverShipped(paths)) failures.push(`${pkg.name}/${found}`)
      for (const found of contentFindings(files, options.markers))
        failures.push(`${pkg.name}/${found}`)
    }
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }

  if (options.npm)
    failures.push(
      ...(await npmParity(
        options.root,
        options.packages,
        snapshot,
        options.npmFiles ?? npmFileList,
      )),
    )
  else if (options.release)
    failures.push("npm is not on PATH: cannot confirm npm publishes the scanned files")
  else notes.push("npm comparison skipped (npm not on PATH)")

  const snapshotPath = join(options.root, SNAPSHOT_FILE)
  if (options.update) {
    writeFileSync(snapshotPath, renderSnapshot(snapshot))
    notes.push(`wrote ${SNAPSHOT_FILE}`)
  } else {
    const committed: PackedSnapshot = existsSync(snapshotPath)
      ? JSON.parse(readFileSync(snapshotPath, "utf8"))
      : {}
    const names = [...new Set([...Object.keys(committed), ...Object.keys(snapshot)])]
    const drift = names.flatMap(
      (name) => describeDrift(name, fileListDrift(committed[name], snapshot[name] ?? [])) ?? [],
    )
    if (drift.length > 0) {
      const header = `published files differ from ${SNAPSHOT_FILE}; review, then run \`bun run check:packed --update\`:`
      if (options.release) failures.push(header, ...drift)
      else notes.push(`${header} (enforced under RELEASE_MODE=1)`, ...drift)
    }
  }
  return { failures, notes, snapshot, fileCount }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..")
  const packages = publishedPackages(root).map((pkg) => ({
    name: pkg.name,
    dir: `packages/${pkg.dir}`,
  }))
  const stale = staleDeclarations(
    packages.map((pkg) => {
      const manifest: unknown = JSON.parse(
        readFileSync(join(root, pkg.dir, "package.json"), "utf8"),
      )
      const types =
        typeof manifest === "object" && manifest !== null && "types" in manifest
          ? manifest.types
          : undefined
      return typeof types === "string"
        ? { name: pkg.name, dir: join(root, pkg.dir), types }
        : { name: pkg.name, dir: join(root, pkg.dir) }
    }),
  )
  if (stale.length > 0) {
    console.error(
      `✗ the packs would hold a stale build; run \`bun run build\` first:\n  ${stale.join("\n  ")}`,
    )
    process.exit(1)
  }
  const release = process.env.RELEASE_MODE === "1"
  const result = await checkPacked({
    root,
    packages,
    markers: privateMarkers(process.env.PRIVATE_MARKERS),
    release,
    update: process.argv.includes("--update"),
    npm: Bun.which("npm") !== null,
  })
  for (const note of result.notes) console.log(`- ${note}`)
  if (result.failures.length > 0) {
    for (const failure of result.failures) console.error(`✗ ${failure}`)
    process.exit(1)
  }
  console.log(
    `✓ packed: ${packages.length} packages, ${result.fileCount} files; nothing that must not ship`,
  )
}
