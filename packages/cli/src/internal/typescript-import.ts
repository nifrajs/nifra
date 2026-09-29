/**
 * The one place the CLI imports TypeScript from.
 *
 * The CLI supports the legacy compiler API shipped by TypeScript 5 and 6 and the
 * split API shipped by TypeScript 7. The scanners only need a small AST surface,
 * so TypeScript 7 is presented through a compatibility facade rather than leaking
 * either compiler's concrete types through the rule registry.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"

/** The legacy compiler API used by the syntax-only scanners and the compatibility facade. */
export type TypeScriptApi = typeof import("typescript")

export const NIFRA_TS_UNSUPPORTED = "NIFRA_TS_UNSUPPORTED" as const

/** A project compiler was found, but its API is outside the scanner adapter's supported range. */
export class UnsupportedTypeScriptError extends Error {
  readonly code = NIFRA_TS_UNSUPPORTED
  readonly version: string

  constructor(version: string) {
    super(unsupportedTypeScriptMessage(version))
    this.name = "UnsupportedTypeScriptError"
    this.version = version
  }
}

export function isUnsupportedTypeScriptError(error: unknown): error is UnsupportedTypeScriptError {
  if (error instanceof UnsupportedTypeScriptError) return true
  if (typeof error !== "object" || error === null) return false
  const candidate = error as {
    readonly code?: unknown
    readonly version?: unknown
    readonly message?: unknown
  }
  return (
    candidate.code === NIFRA_TS_UNSUPPORTED &&
    typeof candidate.version === "string" &&
    typeof candidate.message === "string"
  )
}

export function unsupportedTypeScriptMessage(version: string): string {
  return `${NIFRA_TS_UNSUPPORTED}: TypeScript ${version} is outside the compiler API versions supported by Nifra scanners. Use TypeScript 5, 6, or 7, or pin the project to TypeScript 6 (for example, \`bun add -d typescript@^6\`).`
}

export function unsupportedTypeScriptDiagnostic(version: string): Diagnostic {
  return diagnostic({
    code: NIFRA_TS_UNSUPPORTED,
    severity: "error",
    message: unsupportedTypeScriptMessage(version),
    fix: {
      recipe: "toolchain.install-typescript",
      command: "bun add -d typescript@^6",
    },
    verify: "nifra check --lints-only",
  })
}

/** Source files supplied to the TypeScript 7 virtual file system. */
export interface TypeScriptSourceIndex {
  readonly files: readonly string[]
  read(file: string): string | undefined
  /** Optional temporary project config used by semantic adapters (for example OpenAPI probes). */
  readonly projectConfig?: string
}

/** A compiler plus the process/session that owns it. */
export interface TypeScriptSession {
  readonly compiler: TypeScriptApi
  /** TypeScript 7's asynchronous semantic API, present when a project program was opened. */
  readonly semantic?: TypeScriptSemanticSession
  close(): Promise<void>
}

export interface TypeScriptSemanticSession {
  readonly checker: unknown
  readonly getCheckerForFile: (file: string) => Promise<unknown | undefined>
  readonly getSourceFile: (file: string) => Promise<unknown | undefined>
  readonly typeFlags: Readonly<Record<string, unknown>>
  readonly symbolFlags: Readonly<Record<string, unknown>>
  readonly signatureKind: Readonly<Record<string, unknown>>
}

/**
 * Is this module actually the legacy compiler, rather than TypeScript 7's version
 * entry point or another package published under the same name?
 */
function isCompiler(module: unknown): module is TypeScriptApi {
  if (typeof module !== "object" || module === null) return false
  const api = module as Partial<TypeScriptApi>
  return (
    typeof api.createSourceFile === "function" &&
    api.ScriptKind !== undefined &&
    typeof api.forEachChild === "function"
  )
}

/** Unwrap the CJS default interop wrapper, so both `import * as ts` shapes look the same. */
function compilerOf(module: unknown): TypeScriptApi | undefined {
  if (isCompiler(module)) return module
  const wrapped = (module as { readonly default?: unknown } | undefined)?.default
  return isCompiler(wrapped) ? wrapped : undefined
}

function versionOf(module: unknown): string | undefined {
  if (typeof module !== "object" || module === null) return undefined
  const version = (module as { readonly version?: unknown }).version
  if (typeof version === "string") return version
  const wrapped = (module as { readonly default?: unknown }).default
  if (typeof wrapped !== "object" || wrapped === null) return undefined
  const wrappedVersion = (wrapped as { readonly version?: unknown }).version
  return typeof wrappedVersion === "string" ? wrappedVersion : undefined
}

function majorVersion(version: string): number | undefined {
  const match = /^(\d+)(?:\.|$)/.exec(version.trim())
  if (match === null) return undefined
  const major = Number.parseInt(match[1]!, 10)
  return Number.isSafeInteger(major) ? major : undefined
}

/** Keep unknown fixture versions usable, but reject known compiler majors outside 5/6/7. */
function isUnsupportedVersion(version: string): boolean {
  const major = majorVersion(version)
  return major !== undefined && major > 0 && major !== 5 && major !== 6 && major !== 7
}

function packageVersion(packageRoot: string): string | undefined {
  const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const version = (parsed as { readonly version?: unknown }).version
  return typeof version === "string" ? version : undefined
}

/** Import TypeScript from the CLI's own dependency tree, or `undefined` when it is not installed. */
async function importTypeScriptModule(): Promise<unknown | undefined> {
  try {
    return await import("typescript")
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/cannot find (?:package|module)|ERR_MODULE_NOT_FOUND/i.test(message)) return undefined
    throw cause
  }
}

/** Import the CLI's own TypeScript only for legacy callers. Project loads use the adapter below. */
export async function importTypeScript(): Promise<TypeScriptApi | undefined> {
  const module = await importTypeScriptModule()
  if (module === undefined) return undefined
  const version = versionOf(module)
  if (version !== undefined && isUnsupportedVersion(version))
    throw new UnsupportedTypeScriptError(version)
  return compilerOf(module)
}

function packageRootForResolvedEntry(entry: string): string {
  return dirname(dirname(entry))
}

interface ResolvedProjectTypeScript {
  readonly packageRoot: string
  readonly entry: string
  readonly version: string | undefined
}

/**
 * Find the project's compiler the way module resolution would: `node_modules/typescript` in
 * `root`, then each parent directory up to the filesystem root. This filesystem probe is
 * deliberate: Bun's resolver can memoize a missing package for a long-lived MCP process.
 */
function resolveProjectTypeScript(root: string): ResolvedProjectTypeScript | undefined {
  let dir = root
  while (true) {
    const packageRoot = join(dir, "node_modules", "typescript")
    const entry = join(packageRoot, "lib", "typescript.js")
    if (existsSync(entry)) return { packageRoot, entry, version: packageVersion(packageRoot) }
    if (existsSync(join(packageRoot, "package.json"))) {
      return { packageRoot, entry: packageRoot, version: packageVersion(packageRoot) }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function normalizedPath(path: string): string {
  return resolve(path).replaceAll("\\", "/")
}

// TypeScript 7 canonicalizes Windows paths case-insensitively before virtual-FS callbacks.
function pathIdentity(path: string): string {
  const normalized = normalizedPath(path)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function realPath(path: string): string {
  try {
    // Bun's portable realpath can preserve an 8.3 spelling on Windows; the native
    // implementation resolves the same spelling used by the TypeScript 7 service.
    return normalizedPath(realpathSync.native(path))
  } catch {
    return normalizedPath(realpathSync(path))
  }
}

function canonicalRoot(root: string): string {
  try {
    return realPath(root)
  } catch {
    // Virtual project roots may not exist yet; the resolved spelling is still the best identity.
    return normalizedPath(root)
  }
}

function pathVariants(path: string): readonly string[] {
  const variants = new Set<string>()
  const add = (candidate: string): void => {
    const normalized = normalizedPath(candidate)
    variants.add(normalized)
    if (process.platform === "win32") variants.add(normalized.toLowerCase())
  }
  add(path)
  try {
    add(realPath(path))
  } catch {
    // Virtual fixture files do not exist on disk; their normalized path is sufficient.
  }
  return [...variants]
}

interface TypeScript7Node {
  readonly kind: number
  readonly pos: number
  readonly end: number
  readonly text?: string
  forEachChild<T>(
    visit: (node: TypeScript7Node) => T,
    visitNodes?: (nodes: unknown) => T,
  ): T | undefined
  getStart(sourceFile?: TypeScript7SourceFile): number
  getText(sourceFile?: TypeScript7SourceFile): string
}

interface TypeScript7SourceFile extends TypeScript7Node {
  readonly fileName: string
  readonly text: string
  readonly statements: readonly TypeScript7Node[]
  getLineAndCharacterOfPosition(position: number): {
    readonly line: number
    readonly character: number
  }
}

interface TypeScript7Program {
  getSourceFile(file: string): Promise<TypeScript7SourceFile | undefined>
  getSyntacticDiagnostics(file?: string): Promise<readonly unknown[]>
}

interface TypeScript7Project {
  readonly configFileName: string
  readonly rootFiles: readonly string[]
  readonly program: TypeScript7Program
  readonly checker: unknown
}

interface TypeScript7Snapshot {
  getProject(configFileName: string): TypeScript7Project | undefined
  getDefaultProjectForFile(file: string): Promise<TypeScript7Project | undefined>
  dispose(): Promise<void> | void
}

interface TypeScript7Api {
  updateSnapshot(params: {
    readonly openFiles: readonly string[]
    readonly openProject?: string
  }): Promise<TypeScript7Snapshot>
  close(): Promise<void>
}

interface TypeScript7ApiModule {
  readonly API: new (options?: Record<string, unknown>) => TypeScript7Api
}

type UnknownRecord = Record<string, unknown>

function requiredRecord(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null)
    throw new Error(`TypeScript 7 ${label} export is invalid`)
  return value as UnknownRecord
}

function requiredConstructor(value: unknown, label: string): TypeScript7ApiModule["API"] {
  if (typeof value !== "function") throw new Error(`TypeScript 7 ${label} export is invalid`)
  return value as TypeScript7ApiModule["API"]
}

function requiredNumberMap(module: UnknownRecord, name: string): UnknownRecord {
  return requiredRecord(module[name], name)
}

function hasNodeKind(node: unknown, kinds: ReadonlySet<number>): boolean {
  if (typeof node !== "object" || node === null) return false
  const kind = (node as { readonly kind?: unknown }).kind
  return typeof kind === "number" && kinds.has(kind)
}

function syntaxKinds(module: UnknownRecord, names: readonly string[]): ReadonlySet<number> {
  const syntaxKind = requiredNumberMap(module, "SyntaxKind")
  const values = names.flatMap((name) => {
    const value = syntaxKind[name]
    return typeof value === "number" ? [value] : []
  })
  return new Set(values)
}

function createVirtualFileSystem(
  sourceFiles: ReadonlyMap<string, string>,
  root: string,
): UnknownRecord {
  const rootPaths = pathVariants(root)
  const virtualFiles: string[] = []
  const seenFiles = new Set<string>()
  for (const file of sourceFiles.keys()) {
    const identity = pathIdentity(file)
    if (seenFiles.has(identity)) continue
    seenFiles.add(identity)
    virtualFiles.push(normalizedPath(file))
  }
  const virtualDirectories = new Set<string>()
  let hasVirtualFileInRoot = false
  for (const file of virtualFiles) {
    const normalized = normalizedPath(file)
    const rootPath = rootPaths.find(
      (candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`),
    )
    if (rootPath === undefined) continue
    if (!hasVirtualFileInRoot) {
      // Leave an empty overlay transparent so real project files remain discoverable.
      for (const candidate of rootPaths) virtualDirectories.add(candidate)
      hasVirtualFileInRoot = true
    }
    let directory = normalizedPath(dirname(normalized))
    while (directory === rootPath || directory.startsWith(`${rootPath}/`)) {
      for (const variant of pathVariants(directory)) virtualDirectories.add(variant)
      if (directory === rootPath) break
      directory = normalizedPath(dirname(directory))
    }
  }
  const lookup = (fileName: string): string | undefined => {
    for (const variant of pathVariants(fileName)) {
      const content = sourceFiles.get(variant)
      if (content !== undefined) return content
    }
    return undefined
  }
  return {
    readFile: (fileName: string): string | undefined => lookup(fileName),
    fileExists: (fileName: string): boolean | undefined =>
      lookup(fileName) !== undefined || undefined,
    directoryExists: (directoryName: string): boolean | undefined => {
      const normalized = pathVariants(directoryName).find((variant) =>
        virtualDirectories.has(variant),
      )
      return normalized === undefined ? undefined : true
    },
    getAccessibleEntries: (
      directoryName: string,
    ):
      | { readonly files: readonly string[]; readonly directories: readonly string[] }
      | undefined => {
      const directory = pathVariants(directoryName).find((variant) =>
        virtualDirectories.has(variant),
      )
      if (directory === undefined) return undefined
      const directoryIdentity = pathIdentity(directory)
      const prefix = directoryIdentity.endsWith("/") ? directoryIdentity : `${directoryIdentity}/`
      const files = new Set<string>()
      const directories = new Set<string>()
      for (const file of virtualFiles) {
        const normalized = normalizedPath(file)
        const identity = pathIdentity(normalized)
        if (!identity.startsWith(prefix)) continue
        const remainder = normalized.slice(prefix.length)
        const slash = remainder.indexOf("/")
        if (slash === -1) files.add(remainder)
        else directories.add(remainder.slice(0, slash))
      }
      return { files: [...files], directories: [...directories] }
    },
    realpath: (path: string): string | undefined => {
      const normalized = pathVariants(path).find(
        (variant) => sourceFiles.has(variant) || virtualDirectories.has(variant),
      )
      return normalized
    },
  }
}

function sourceEntries(
  root: string,
  sourceIndex: TypeScriptSourceIndex | undefined,
): { readonly files: Map<string, string>; readonly paths: string[] } {
  const files = new Map<string, string>()
  if (sourceIndex === undefined) return { files, paths: [] }
  const paths: string[] = []
  for (const file of sourceIndex.files) {
    const content = sourceIndex.read(file)
    if (content === undefined) continue
    const absolute = isAbsolute(file) ? file : resolve(root, file)
    const normalized = normalizedPath(absolute)
    paths.push(normalized)
    for (const variant of pathVariants(normalized)) files.set(variant, content)
  }
  return { files, paths: [...new Set(paths)] }
}

/** Build a TypeScript 7 facade over unstable/ast and the async project API. */
async function createTypeScript7Session(
  root: string,
  packageRoot: string,
  version: string,
  sourceIndex: TypeScriptSourceIndex | undefined,
): Promise<TypeScriptSession> {
  // Resolve subpaths from the exact package installation selected above. Resolving from `root`
  // alone can select a different hoisted TypeScript copy when this loader is used from a CLI that
  // has its own peer installation.
  const packageResolveRoot = dirname(packageRoot)
  const astPath = Bun.resolveSync("typescript/unstable/ast", packageResolveRoot)
  const asyncPath = Bun.resolveSync("typescript/unstable/async", packageResolveRoot)
  const astModule = requiredRecord(await import(pathToFileURL(astPath).href), "ast")
  const asyncModule = requiredRecord(await import(pathToFileURL(asyncPath).href), "async")
  const API = requiredConstructor(asyncModule.API, "async.API")
  // Windows can return a DOS 8.3 spelling from os.tmpdir() (for example RUNNER~1), while the
  // TypeScript 7 project service resolves the same directory to its long spelling. Keep cwd,
  // virtual files, and open files on one canonical path identity so project discovery is stable.
  const sessionRoot = canonicalRoot(root)
  const { files, paths } = sourceEntries(sessionRoot, sourceIndex)
  const projectConfig = sourceIndex?.projectConfig ?? join(sessionRoot, "tsconfig.json")
  const sourceCache = new Map<string, TypeScript7SourceFile>()
  const sourceByContent = new Map<string, TypeScript7SourceFile>()
  const projects = new Map<string, TypeScript7Project>()

  const api = new API({
    cwd: sessionRoot,
    fs: createVirtualFileSystem(files, sessionRoot),
  })
  let snapshot: TypeScript7Snapshot | undefined
  let configuredProject: TypeScript7Project | undefined
  let closed = false
  try {
    snapshot = await api.updateSnapshot({
      openFiles: paths,
      ...(existsSync(projectConfig) ? { openProject: projectConfig } : {}),
    })
    configuredProject =
      sourceIndex?.projectConfig === undefined ? undefined : snapshot.getProject(projectConfig)
    if (sourceIndex?.projectConfig !== undefined && configuredProject === undefined) {
      throw new Error(`TypeScript 7 could not open project config ${projectConfig}`)
    }
    for (const path of paths) {
      const project = configuredProject ?? (await snapshot.getDefaultProjectForFile(path))
      if (project === undefined) {
        throw new Error(`TypeScript 7 could not create a project for source file ${path}`)
      }
      projects.set(pathIdentity(path), project)
      const source = await project.program.getSourceFile(path)
      if (source === undefined) {
        throw new Error(`TypeScript 7 could not load project source file ${path}`)
      }
      for (const variant of pathVariants(path)) sourceCache.set(variant, source)
      for (const variant of pathVariants(source.fileName)) sourceCache.set(variant, source)
      sourceByContent.set(source.text, source)
      const diagnostics = await project.program.getSyntacticDiagnostics(path)
      // Legacy scanners use parseDiagnostics to avoid interpreting recovery nodes. The remote
      // TypeScript 7 source object is extensible in current releases; define the same optional
      // property without copying source text or changing node identities.
      try {
        Object.defineProperty(source, "parseDiagnostics", {
          configurable: true,
          enumerable: false,
          value: diagnostics,
        })
      } catch {
        // A future remote source implementation may be sealed. The scanner remains conservative
        // for files whose syntax diagnostics are not observable through the compatibility object.
      }
    }
  } catch (error) {
    await snapshot?.dispose()
    await api.close()
    throw error
  }

  const functionLikeKinds = syntaxKinds(astModule, [
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunction",
    "MethodDeclaration",
    "GetAccessor",
    "SetAccessor",
    "Constructor",
    "MethodSignature",
    "CallSignature",
    "ConstructSignature",
    "IndexSignature",
    "FunctionType",
    "ConstructorType",
    "JSDocFunctionType",
    "JSDocSignature",
  ])
  const parameterKinds = syntaxKinds(astModule, ["Parameter"])
  const stringLiteralKinds = syntaxKinds(astModule, [
    "StringLiteral",
    "NoSubstitutionTemplateLiteral",
  ])

  const createSourceFile = (_fileName: unknown, sourceText: unknown): unknown => {
    if (typeof _fileName !== "string" || typeof sourceText !== "string") {
      throw new TypeError("TypeScript 7 createSourceFile received invalid arguments")
    }
    const absolute = isAbsolute(_fileName) ? _fileName : resolve(sessionRoot, _fileName)
    const cached = pathVariants(absolute)
      .map((variant) => sourceCache.get(variant))
      .find((source): source is TypeScript7SourceFile => source !== undefined)
    if (cached !== undefined && cached.text === sourceText) return cached
    const byContent = sourceByContent.get(sourceText)
    if (byContent !== undefined) return byContent
    throw new Error(`TypeScript 7 source file was not preloaded: ${_fileName}`)
  }
  const forEachChild = (node: unknown, visit: unknown): unknown => {
    if (typeof visit !== "function")
      throw new TypeError("TypeScript 7 forEachChild visitor is invalid")
    if (typeof node !== "object" || node === null)
      throw new TypeError("TypeScript 7 node is invalid")
    const childVisitor = visit as (child: TypeScript7Node) => unknown
    return (node as TypeScript7Node).forEachChild(childVisitor)
  }
  const isFunctionLike = (node: unknown): boolean => hasNodeKind(node, functionLikeKinds)
  const isParameter = (node: unknown): boolean => hasNodeKind(node, parameterKinds)
  const isStringLiteralLike = (node: unknown): boolean => hasNodeKind(node, stringLiteralKinds)

  const facade: UnknownRecord = {
    ...astModule,
    version,
    createSourceFile,
    forEachChild,
    isFunctionLike,
    isParameter,
    isStringLiteralLike,
  }
  const compiler = Object.freeze(facade) as unknown as TypeScriptApi

  const firstProject = projects.values().next().value as TypeScript7Project | undefined
  const semantic =
    firstProject === undefined
      ? undefined
      : ({
          checker: firstProject.checker,
          getCheckerForFile: async (file: string): Promise<unknown | undefined> => {
            const project =
              projects.get(pathIdentity(file)) ??
              configuredProject ??
              (await snapshot!.getDefaultProjectForFile(file))
            return project?.checker
          },
          getSourceFile: async (file: string): Promise<unknown | undefined> => {
            const project =
              projects.get(pathIdentity(file)) ??
              configuredProject ??
              (await snapshot!.getDefaultProjectForFile(file))
            return project?.program.getSourceFile(file)
          },
          typeFlags: requiredNumberMap(asyncModule, "TypeFlags"),
          symbolFlags: requiredNumberMap(asyncModule, "SymbolFlags"),
          signatureKind: requiredNumberMap(asyncModule, "SignatureKind"),
        } satisfies TypeScriptSemanticSession)

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await snapshot?.dispose()
    await api.close()
  }
  return {
    compiler,
    ...(semantic === undefined ? {} : { semantic }),
    close,
  }
}

function legacySession(compiler: TypeScriptApi): TypeScriptSession {
  return { compiler, close: async () => {} }
}

interface ResolvedLoad {
  readonly session: TypeScriptSession | undefined
  readonly unsupported: UnsupportedTypeScriptError | undefined
}

async function resolveProjectSession(
  root: string,
  sourceIndex: TypeScriptSourceIndex | undefined,
): Promise<ResolvedLoad> {
  const resolved = resolveProjectTypeScript(root)
  if (resolved === undefined) {
    const module = await importTypeScriptModule()
    if (module === undefined) return { session: undefined, unsupported: undefined }
    const version = versionOf(module)
    if (version !== undefined && isUnsupportedVersion(version))
      throw new UnsupportedTypeScriptError(version)
    if (majorVersion(version ?? "") === 7) {
      const entry = Bun.resolveSync("typescript", import.meta.dir)
      return {
        session: await createTypeScript7Session(
          root,
          packageRootForResolvedEntry(entry),
          version ?? "7",
          sourceIndex,
        ),
        unsupported: undefined,
      }
    }
    const compiler = compilerOf(module)
    return {
      session: compiler === undefined ? undefined : legacySession(compiler),
      unsupported: undefined,
    }
  }
  if (resolved.version !== undefined && isUnsupportedVersion(resolved.version)) {
    throw new UnsupportedTypeScriptError(resolved.version)
  }
  const major = resolved.version === undefined ? undefined : majorVersion(resolved.version)
  if (major === 7) {
    return {
      session: await createTypeScript7Session(
        root,
        resolved.packageRoot,
        resolved.version ?? "7",
        sourceIndex,
      ),
      unsupported: undefined,
    }
  }
  const module = await import(pathToFileURL(resolved.entry).href)
  const version = resolved.version ?? versionOf(module)
  if (version !== undefined && isUnsupportedVersion(version))
    throw new UnsupportedTypeScriptError(version)
  const compiler = compilerOf(module)
  if (compiler === undefined) {
    throw new Error(
      `TypeScript package at ${resolved.packageRoot} does not expose the legacy compiler API`,
    )
  }
  return { session: legacySession(compiler), unsupported: undefined }
}

/**
 * Import TypeScript resolved from the PROJECT root first, with TypeScript 7's package exports
 * selected explicitly. A project TypeScript 7 install never falls back to the CLI's compiler.
 */
export async function importProjectTypeScript(
  root: string,
  sourceIndex?: TypeScriptSourceIndex,
): Promise<TypeScriptApi | undefined> {
  const loaded = await resolveProjectSession(root, sourceIndex)
  return loaded.session?.compiler
}

export interface ProjectTypeScriptLoad {
  readonly compiler: TypeScriptApi | undefined
  readonly session: TypeScriptSession | undefined
  readonly unsupported: UnsupportedTypeScriptError | undefined
}

/** Load a project compiler for scanners while preserving a structured unsupported-toolchain result. */
export async function loadProjectTypeScript(
  root: string,
  load?: () => Promise<TypeScriptApi | undefined>,
  sourceIndex?: TypeScriptSourceIndex,
): Promise<ProjectTypeScriptLoad> {
  try {
    if (load !== undefined) {
      const compiler = await load()
      return {
        compiler,
        session: compiler === undefined ? undefined : legacySession(compiler),
        unsupported: undefined,
      }
    }
    const resolved = await resolveProjectSession(root, sourceIndex)
    return {
      compiler: resolved.session?.compiler,
      session: resolved.session,
      unsupported: resolved.unsupported,
    }
  } catch (error) {
    if (isUnsupportedTypeScriptError(error)) {
      return { compiler: undefined, session: undefined, unsupported: error }
    }
    throw error
  }
}
