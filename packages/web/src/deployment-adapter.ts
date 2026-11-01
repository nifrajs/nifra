/**
 * Public contract for build-time deployment adapters. An adapter chooses one of Nifra's existing
 * runtime targets and adds host-specific, declarative files to its completed output. It never gets
 * a hook into request handling or the generated server entry.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path"
import type { BuildTarget } from "./build-plan.ts"
import { assertDisposableDir } from "./internal/disposable-dir.ts"
import {
  assertNoSecrets,
  buildEnvironment,
  emittedScanFiles,
  type SecretExemption,
  textOf,
} from "./internal/secret-scan.ts"

export const DEPLOYMENT_ADAPTER_API_VERSION = 1 as const

/** A portable file an adapter wants to add to the finished deploy directory. */
export interface DeploymentAdapterFile {
  /** POSIX path relative to the deploy directory, such as `Dockerfile` or `.well-known/host.txt`. */
  readonly path: string
  /** Text or bytes. Text files and decodable byte files are scanned for credentials before publish. */
  readonly contents: string | Uint8Array
}

/** Stable facts passed to an adapter after the selected built-in target has been assembled. */
export interface DeploymentAdapterContext {
  readonly adapterId: string
  readonly appRoot: string
  readonly baseTarget: BuildTarget
  /** Staged, completed build output. Treat it as read-only; Nifra publishes it after validation. */
  readonly outDir: string
  /** The adapter's validated and normalized options. */
  readonly options: Readonly<Record<string, unknown>>
  /** The base builder's result. Its shape depends on whether the app uses ordinary SSR or components. */
  readonly result: unknown
}

/** Files and deploy/run guidance emitted by a deployment adapter. */
export interface DeploymentAdapterOutput {
  readonly files: readonly DeploymentAdapterFile[]
  readonly run: string
}

/**
 * A versioned public deployment adapter. `baseTarget` selects Nifra's runtime/build semantics; the
 * adapter only describes packaging metadata and files. `componentPipeline` must be true for an
 * adapter to opt into Nifra's separate coordinated component pipeline.
 */
export interface DeploymentTargetAdapter {
  readonly apiVersion: typeof DEPLOYMENT_ADAPTER_API_VERSION
  /** Stable lowercase target key used by `nifra build --target <id>` and `nifra target <id>`. */
  readonly id: string
  readonly baseTarget: BuildTarget
  readonly capabilities: {
    /** Whether this adapter knows how to package the coordinated component pipeline output. */
    readonly componentPipeline: boolean
  }
  /** Validate and normalize untrusted config data before Nifra starts a build or clears output. */
  readonly validateOptions: (input: unknown) => Readonly<Record<string, unknown>>
  /** Return additional files and the provider-specific deployment instruction. No filesystem writes. */
  readonly emit: (
    context: DeploymentAdapterContext,
  ) => DeploymentAdapterOutput | Promise<DeploymentAdapterOutput>
}

export interface DeploymentAdapterBuildInput<T> {
  readonly adapter: DeploymentTargetAdapter
  readonly appRoot: string
  readonly outDir: string
  readonly options?: unknown
  readonly secretExemptions?: readonly SecretExemption[]
  /** External source paths the final output must never replace, especially an external `publicDir`. */
  readonly protectedPaths: readonly string[]
  readonly componentPipeline?: boolean
  /** The existing target builder, called with a fresh sibling staging directory. */
  readonly build: (stagingOutDir: string) => Promise<T>
}

export interface DeploymentAdapterBuildResult<T> {
  /**
   * The base builder's result. Paths in it may point into the temporary staging directory, which is
   * deleted before this function returns; use the returned `DeploymentAdapterBuildResult.outDir` for
   * published paths.
   */
  readonly result: T
  readonly outDir: string
  readonly run: string
  readonly adapterId: string
  readonly baseTarget: BuildTarget
}

const BUILTIN_IDS = new Set(["bun", "node", "deno", "cloudflare", "vercel", "static"])
const MAX_ADAPTER_FILES = 256
const MAX_ADAPTER_FILE_BYTES = 2 * 1024 * 1024
const MAX_ADAPTER_TOTAL_BYTES = 8 * 1024 * 1024

/** Read a path without following symlinks and treat only missing path components as absent. */
function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, "code") : undefined
    if (code === "ENOENT" || code === "ENOTDIR") return undefined
    throw error
  }
}

/** Detect adapter writes without reading and hashing potentially large public media files. */
function snapshotOutput(root: string): ReadonlyMap<string, string> {
  const snapshot = new Map<string, string>()
  let entries = 0
  const walk = (directory: string, relative: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 250_000)
        throw new Error("[nifra/web] deployment output exceeds 250000 entries")
      const path = join(directory, item.name)
      const key = relative === "" ? item.name : `${relative}/${item.name}`
      const stat = lstatSync(path, { bigint: true })
      if (stat.isSymbolicLink())
        throw new Error(`[nifra/web] deployment output contains a symbolic link: ${key}`)
      if (stat.isDirectory()) {
        snapshot.set(key, `directory:${stat.mtimeNs}:${stat.ctimeNs}`)
        walk(path, key)
      } else if (stat.isFile()) {
        snapshot.set(
          key,
          `file:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}:${stat.ino}`,
        )
      } else {
        throw new Error(`[nifra/web] deployment output contains a special file: ${key}`)
      }
    }
  }
  walk(root, "")
  return snapshot
}

/** Refuse an adapter that mutated the base output instead of returning declarative additions. */
function assertOutputUnchanged(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  adapterId: string,
): void {
  if (before.size === after.size && [...before].every(([path, stat]) => after.get(path) === stat))
    return
  throw new Error(
    `[nifra/web] deployment adapter ${adapterId} modified its read-only base output; emit additions through the returned files array`,
  )
}

/** Reject control bytes from paths and guidance that Nifra will persist or print. */
function hasForbiddenControlCharacter(value: string, allowWhitespace = false): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x7f || (code <= 0x1f && !(allowWhitespace && code >= 0x09 && code <= 0x0d)))
      return true
  }
  return false
}

/** Check adapter identity and callable shape before running trusted build-time adapter code. */
function validateAdapter(adapter: DeploymentTargetAdapter): void {
  if (typeof adapter !== "object" || adapter === null)
    throw new TypeError("[nifra/web] deployment adapter must be an object")
  if (adapter.apiVersion !== DEPLOYMENT_ADAPTER_API_VERSION) {
    throw new Error(
      `[nifra/web] deployment adapter ${String(adapter.id)} uses API ${String(adapter.apiVersion)}; ` +
        `this Nifra build supports API ${DEPLOYMENT_ADAPTER_API_VERSION}`,
    )
  }
  if (
    typeof adapter.id !== "string" ||
    !/^[a-z][a-z0-9-]{1,62}$/.test(adapter.id) ||
    BUILTIN_IDS.has(adapter.id)
  )
    throw new Error(
      `[nifra/web] deployment adapter id must be a lowercase, non-reserved target key (received ${String(adapter.id)})`,
    )
  if (typeof adapter.baseTarget !== "string" || !BUILTIN_IDS.has(adapter.baseTarget))
    throw new Error(`[nifra/web] deployment adapter ${adapter.id} has an unsupported baseTarget`)
  if (
    typeof adapter.capabilities !== "object" ||
    adapter.capabilities === null ||
    typeof adapter.capabilities.componentPipeline !== "boolean"
  )
    throw new Error(
      `[nifra/web] deployment adapter ${adapter.id} must declare capabilities.componentPipeline`,
    )
  if (typeof adapter.validateOptions !== "function" || typeof adapter.emit !== "function")
    throw new Error(
      `[nifra/web] deployment adapter ${adapter.id} must implement validateOptions() and emit()`,
    )
}

/** Accept portable relative POSIX paths and reject traversal or platform-specific names. */
function portableRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > 240 ||
    path.includes("\\") ||
    hasForbiddenControlCharacter(path) ||
    path.includes(":") ||
    path.startsWith("/") ||
    isAbsolute(path) ||
    posix.normalize(path) !== path
  )
    return false
  const parts = path.split("/")
  return parts.every(
    (part) =>
      part.length > 0 &&
      part !== "." &&
      part !== ".." &&
      !/[. ]$/.test(part) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part),
  )
}

/** Validate, scan, and write the adapter's declarative files into the staged base output. */
function writeAdapterFiles(
  outDir: string,
  files: readonly DeploymentAdapterFile[],
  secretExemptions: readonly SecretExemption[] | undefined,
  run: string,
  reservedPaths: ReadonlyMap<string, string>,
): void {
  if (!Array.isArray(files) || files.length > MAX_ADAPTER_FILES)
    throw new Error(`[nifra/web] deployment adapter may emit at most ${MAX_ADAPTER_FILES} files`)
  let totalBytes = 0
  const paths = new Map<string, { readonly path: string; readonly kind: "file" | "directory" }>(
    [...reservedPaths].map(([path, stat]) => [
      path.toLowerCase(),
      { path, kind: stat.startsWith("directory:") ? "directory" : "file" },
    ]),
  )
  const scanArtifacts: { name: string; text: string }[] = []
  for (const file of files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.path !== "string" ||
      !portableRelativePath(file.path)
    )
      throw new Error(
        `[nifra/web] deployment adapter emitted an invalid relative path: ${String(file?.path)}`,
      )
    const parts = file.path.split("/")
    for (let i = 1; i < parts.length; i += 1) {
      const prefix = parts.slice(0, i).join("/")
      const prefixKey = prefix.toLowerCase()
      const existing = paths.get(prefixKey)
      if (existing !== undefined && existing.path !== prefix)
        throw new Error(
          `[nifra/web] deployment adapter path ${file.path} has a case-insensitive directory collision at ${prefix}`,
        )
      if (existing?.kind === "file")
        throw new Error(`[nifra/web] deployment adapter path crosses a file: ${prefix}`)
      if (existing === undefined) paths.set(prefixKey, { path: prefix, kind: "directory" })
    }
    const portableKey = file.path.toLowerCase()
    if (paths.has(portableKey))
      throw new Error(
        `[nifra/web] deployment adapter file ${file.path} collides with an existing path, including case-insensitive filesystems`,
      )
    paths.set(portableKey, { path: file.path, kind: "file" })
    if (typeof file.contents !== "string" && !(file.contents instanceof Uint8Array))
      throw new Error(`[nifra/web] deployment adapter file ${file.path} must contain text or bytes`)
    const bytes = typeof file.contents === "string" ? Buffer.from(file.contents) : file.contents
    if (bytes.byteLength > MAX_ADAPTER_FILE_BYTES)
      throw new Error(
        `[nifra/web] deployment adapter file ${file.path} exceeds ${MAX_ADAPTER_FILE_BYTES} bytes`,
      )
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_ADAPTER_TOTAL_BYTES)
      throw new Error(
        `[nifra/web] deployment adapter output exceeds ${MAX_ADAPTER_TOTAL_BYTES} bytes`,
      )
    const text = typeof file.contents === "string" ? file.contents : textOf(bytes)
    if (text !== undefined) scanArtifacts.push(...emittedScanFiles(file.path, text))
  }
  const secretScan = {
    env: buildEnvironment(),
    artifacts: [...scanArtifacts, ...emittedScanFiles("deployment-adapter-run", run)],
  }
  if (secretExemptions === undefined) assertNoSecrets(secretScan)
  else assertNoSecrets({ ...secretScan, exemptions: secretExemptions })

  for (const file of files) {
    const destination = resolve(outDir, ...file.path.split("/"))
    let parent = outDir
    for (const part of file.path.split("/").slice(0, -1)) {
      parent = join(parent, part)
      if (lstatIfPresent(parent) === undefined) mkdirSync(parent)
      const stat = lstatSync(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`[nifra/web] deployment adapter path crosses a non-directory: ${file.path}`)
    }
    if (lstatIfPresent(destination) !== undefined)
      throw new Error(
        `[nifra/web] deployment adapter file ${file.path} collides with a file from the base build`,
      )
    writeFileSync(destination, file.contents, { flag: "wx", mode: 0o644 })
  }
}

/**
 * Build a base target and publish adapter additions as one transaction. A failed base build, adapter,
 * validation, secret scan or publish leaves the prior output directory in place.
 */
export async function buildWithDeploymentAdapter<T>(
  input: DeploymentAdapterBuildInput<T>,
): Promise<DeploymentAdapterBuildResult<T>> {
  const { adapter } = input
  validateAdapter(adapter)
  if (input.componentPipeline === true && !adapter.capabilities.componentPipeline) {
    throw new Error(
      `[nifra/web] deployment adapter ${adapter.id} does not support the component pipeline`,
    )
  }
  const options = adapter.validateOptions(input.options)
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  )
    throw new Error(
      `[nifra/web] deployment adapter ${adapter.id} validateOptions() must return a plain object`,
    )

  const outDir = resolve(input.outDir)
  const appRoot = resolve(input.appRoot)
  const protectedPaths = [appRoot, process.cwd(), ...input.protectedPaths]
  assertDisposableDir("outDir", outDir, protectedPaths)
  const existingOutput = lstatIfPresent(outDir)
  if (existingOutput?.isSymbolicLink())
    throw new Error(`[nifra/web] outDir (${outDir}) is a symlink; refusing to replace it`)

  const parent = dirname(outDir)
  mkdirSync(parent, { recursive: true })
  const stageRoot = mkdtempSync(join(parent, `.${basename(outDir)}.nifra-adapter-`))
  const stagingOutDir = join(stageRoot, "output")
  const previousOutDir = join(stageRoot, "previous")
  let previousMoved = false
  let published = false
  let preserveStage = false
  try {
    const result = await input.build(stagingOutDir)
    const beforeAdapter = snapshotOutput(stagingOutDir)
    const emitted = await adapter.emit({
      adapterId: adapter.id,
      appRoot,
      baseTarget: adapter.baseTarget,
      outDir: stagingOutDir,
      options: Object.freeze({ ...options }),
      result,
    })
    assertOutputUnchanged(beforeAdapter, snapshotOutput(stagingOutDir), adapter.id)
    if (
      typeof emitted !== "object" ||
      emitted === null ||
      typeof emitted.run !== "string" ||
      emitted.run.trim().length === 0 ||
      emitted.run.length > 1000 ||
      hasForbiddenControlCharacter(emitted.run, true) ||
      !Array.isArray(emitted.files)
    )
      throw new Error(
        `[nifra/web] deployment adapter ${adapter.id} emit() must return files and non-empty run guidance`,
      )
    writeAdapterFiles(
      stagingOutDir,
      emitted.files,
      input.secretExemptions,
      emitted.run,
      beforeAdapter,
    )

    // Re-check immediately before moving the previous output; paths may have changed during the build.
    assertDisposableDir("outDir", outDir, protectedPaths)
    if (lstatIfPresent(outDir) !== undefined) {
      if (lstatSync(outDir).isSymbolicLink())
        throw new Error(`[nifra/web] outDir (${outDir}) became a symlink; refusing to replace it`)
      renameSync(outDir, previousOutDir)
      previousMoved = true
    }
    try {
      renameSync(stagingOutDir, outDir)
      published = true
    } catch (error) {
      if (previousMoved) {
        renameSync(previousOutDir, outDir)
        previousMoved = false
      }
      throw error
    }
    if (previousMoved) {
      try {
        rmSync(previousOutDir, { recursive: true, force: true })
        previousMoved = false
      } catch {
        // The new output is already published; a stale backup is safe to clean up later.
      }
    }
    return {
      result,
      outDir,
      run: emitted.run,
      adapterId: adapter.id,
      baseTarget: adapter.baseTarget,
    }
  } finally {
    if (previousMoved && !published && lstatIfPresent(outDir) === undefined) {
      try {
        renameSync(previousOutDir, outDir)
      } catch {
        // Preserve the original failure; the backup remains in stageRoot for manual recovery.
        preserveStage = true
      }
    }
    if (!preserveStage) {
      try {
        rmSync(stageRoot, { recursive: true, force: true })
      } catch {
        // Cleanup is best-effort; never fail a published build or replace the original error.
      }
    }
  }
}
