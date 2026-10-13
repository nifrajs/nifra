/**
 * After a release, reads what npm actually serves. Each public package's tarball, at its manifest
 * version, is fetched from the registry, checked against the registry's own integrity hash, and held
 * to what the release verified: the file list in packed-files.json, nothing `NEVER_SHIPPED`, no
 * private marker (`PRIVATE_MARKERS`) and no home-directory path.
 *
 *   bun run verify:published                         the versions in the package manifests
 *   bun run verify:published --version 5.0.0         one version for every package
 *   bun run verify:published --wait 600              retry a version npm does not serve yet
 *   bun run verify:published --write-snapshot        record the published file lists instead
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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

const CONCURRENCY = 8
const RETRY_MS = 15_000

/** Whether `bytes` hash to an npm `dist.integrity` value (`sha512-<base64>`). */
export function integrityMatches(bytes: Uint8Array, integrity: string): boolean {
  const [algorithm, expected] = integrity.split("-", 2)
  if (algorithm !== "sha512" || expected === undefined) return false
  return new Bun.CryptoHasher("sha512").update(bytes).digest("base64") === expected
}

/** What is wrong with one published tarball's bytes and contents, and the paths it holds. */
export function publishedTarballFailures(
  name: string,
  tarball: { readonly bytes: Uint8Array; readonly integrity: string },
  markers: readonly string[],
): { readonly failures: string[]; readonly paths: string[] } {
  if (!integrityMatches(tarball.bytes, tarball.integrity))
    return {
      failures: [`${name}: tarball does not match the registry's integrity hash`],
      paths: [],
    }
  const dir = mkdtempSync(join(tmpdir(), "nifra-published-"))
  try {
    const file = join(dir, "package.tgz")
    writeFileSync(file, tarball.bytes)
    const files = readTarball(file)
    const paths = files.map((entry) => entry.path)
    const failures = [
      ...neverShipped(paths).map((found) => `${name}/${found}`),
      ...contentFindings(files, markers).map((found) => `${name}/${found}`),
    ]
    return { failures, paths }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The registry calls `fetchPublished` makes, so a test can stand in for npm and the clock. */
export interface RegistryAccess {
  readonly fetch: (url: string) => Promise<Response>
  readonly sleep: (ms: number) => Promise<unknown>
  readonly now: () => number
}

const liveRegistry: RegistryAccess = { fetch: (url) => fetch(url), sleep: Bun.sleep, now: Date.now }

/** A published tarball and its integrity hash, or why it could not be read. A 404 is retried until
 * `waitMs` passes, on the tarball as on the metadata: npm can serve a new version's metadata before
 * its tarball. */
export async function fetchPublished(
  registry: string,
  name: string,
  version: string,
  waitMs: number,
  access: RegistryAccess = liveRegistry,
): Promise<{ bytes: Uint8Array; integrity: string } | string> {
  const deadline = access.now() + waitMs
  for (;;) {
    const response = await access.fetch(`${registry}/${name.replaceAll("/", "%2f")}/${version}`)
    if (response.ok) {
      const meta: unknown = await response.json()
      const dist: unknown =
        typeof meta === "object" && meta !== null && "dist" in meta ? meta.dist : undefined
      const field = (key: string): unknown =>
        typeof dist === "object" && dist !== null ? Reflect.get(dist, key) : undefined
      const tarball = field("tarball")
      const integrity = field("integrity")
      if (typeof tarball !== "string" || typeof integrity !== "string")
        return `${name}@${version}: registry metadata has no dist.tarball or dist.integrity`
      const download = await access.fetch(tarball)
      if (download.ok) return { bytes: new Uint8Array(await download.arrayBuffer()), integrity }
      if (download.status !== 404 || access.now() >= deadline)
        return `${name}@${version}: tarball download failed (${download.status})`
    } else if (response.status !== 404 || access.now() >= deadline) {
      return `${name}@${version}: registry answered ${response.status}`
    }
    await access.sleep(RETRY_MS)
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..")
  const argv = process.argv.slice(2)
  const option = (flag: string): string | undefined => {
    const at = argv.indexOf(flag)
    return at === -1 ? undefined : argv[at + 1]
  }
  const pinned = option("--version")
  const waitMs = Number(option("--wait") ?? 0) * 1000
  const writeSnapshot = argv.includes("--write-snapshot")
  const registry = process.env.NPM_REGISTRY ?? "https://registry.npmjs.org"
  const markers = privateMarkers(process.env.PRIVATE_MARKERS)
  const snapshot: PackedSnapshot = writeSnapshot
    ? {}
    : JSON.parse(await Bun.file(join(root, SNAPSHOT_FILE)).text())

  const queue = publishedPackages(root).map((pkg) => ({
    name: pkg.name,
    version: pinned ?? pkg.version ?? "",
  }))
  const failures: string[] = []
  const published: Record<string, readonly string[]> = {}
  let files = 0
  const worker = async (): Promise<void> => {
    for (let pkg = queue.shift(); pkg !== undefined; pkg = queue.shift()) {
      const fetched = await fetchPublished(registry, pkg.name, pkg.version, waitMs)
      if (typeof fetched === "string") {
        failures.push(fetched)
        continue
      }
      const label = `${pkg.name}@${pkg.version}`
      const result = publishedTarballFailures(label, fetched, markers)
      published[pkg.name] = result.paths
      files += result.paths.length
      failures.push(...result.failures)
      if (writeSnapshot || result.paths.length === 0) continue
      const expected = snapshot[pkg.name]
      if (expected === undefined) failures.push(`${label}: not in ${SNAPSHOT_FILE}`)
      const drift = describeDrift(
        `${label}: published files differ from ${SNAPSHOT_FILE}`,
        fileListDrift(expected, result.paths),
      )
      if (expected !== undefined && drift !== undefined) failures.push(drift)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  if (markers.length === 0) console.log("- marker scan skipped (PRIVATE_MARKERS unset)")
  if (failures.length > 0) {
    for (const failure of failures.sort()) console.error(`✗ ${failure}`)
    process.exit(1)
  }
  if (writeSnapshot) {
    writeFileSync(join(root, SNAPSHOT_FILE), renderSnapshot(published))
    console.log(`✓ wrote ${SNAPSHOT_FILE} from ${Object.keys(published).length} published tarballs`)
  } else {
    console.log(
      `✓ published: ${Object.keys(published).length} tarballs, ${files} files, each matching the registry hash and ${SNAPSHOT_FILE}`,
    )
  }
}
