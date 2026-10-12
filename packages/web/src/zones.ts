/**
 * `@nifrajs/web/zones` - which side of the app a source file belongs to.
 *
 * One classifier, used by both client builds, both dev servers and `nifra check`, so they cannot
 * disagree about what may reach a browser. It classifies a RESOLVED file by its real path: the
 * bundler has already applied tsconfig `paths`, aliases and package `exports`, and a workspace
 * package linked through `node_modules` resolves to a path outside any `node_modules` directory, so
 * it is first-party and must say which side it is on.
 *
 * Default-deny: a first-party file that no rule places is an error, never "probably fine".
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  type EntryOwnership,
  type EnvironmentDeclaration,
  entryKey,
  entryOwnership,
  parseEnvironment,
} from "./internal/package-entries.ts"
import { SERVER_FN_MODULE } from "./internal/server-boundary.ts"
import { withoutQuery } from "./internal/without-query.ts"

export type Zone =
  /** A page or special file under `routes/` - the frontend half of a route. */
  | "route-frontend"
  /** A route's `x.backend.ts` twin. */
  | "route-backend"
  | "frontend"
  | "backend"
  | "shared"
  /** A server-function module (`*.fn.ts`); the browser only ever receives its generated RPC stub. */
  | "fn"
  /** A compiler-owned server UI module; only opaque reference stubs may reach a browser. */
  | "component"
  /** Framework output (the client entry, the server composition, generated types). */
  | "generated"
  /** A third-party package, or a workspace package declaring `"nifra": { "environment": "library" }`. */
  | "library"

export type Classification =
  | {
      readonly zone: Zone
      /** The package a `library` file belongs to. */
      readonly packageName?: string
      /** A `library` package's own declaration, when it made one. */
      readonly declared?: PackageEnvironment
      /** A third-party file's path inside `node_modules`: `drizzle-orm/node-postgres/index.js`. */
      readonly modulePath?: string
      /** The export subpath (`"./react"`) whose own declared side decided this import. */
      readonly entry?: string
    }
  | {
      readonly zone: "error"
      readonly reason: string
      /** The undeclared package this error is about: every file in it shares the one fix. */
      readonly package?: string
      /** The export subpath the import named, when the package's map gives it no side. */
      readonly entry?: string
    }

export type PackageEnvironment = "frontend" | "backend" | "shared" | "library"
const PACKAGE_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "frontend",
  "backend",
  "shared",
  "library",
])

/** Zones whose code may ship to a browser. `fn` is listed because its stub is what ships. */
export const BROWSER_ZONES: ReadonlySet<Zone> = new Set([
  "route-frontend",
  "frontend",
  "shared",
  "fn",
  "generated",
  "library",
])

const SERVER_ZONES: ReadonlySet<Zone> = new Set(["route-backend", "backend", "fn"])
const FRONTEND_ZONES: ReadonlySet<Zone> = new Set(["route-frontend", "frontend"])

/**
 * Third-party packages that never belong in a browser bundle: database drivers, ORMs' server
 * entries, mailers and server SDKs. A package reaching a `node:` builtin is caught separately; this
 * list covers the ones that bundle "fine" and leak credentials or query code instead.
 */
export const SERVER_PACKAGES: readonly string[] = [
  "@libsql/client",
  "@neondatabase/serverless",
  "@planetscale/database",
  "@prisma/client",
  "@sendgrid/mail",
  "@vercel/postgres",
  "argon2",
  "bcrypt",
  "bcryptjs",
  "better-sqlite3",
  "drizzle-kit",
  "firebase-admin",
  "ioredis",
  "jsonwebtoken",
  "knex",
  "mongodb",
  "mongoose",
  "mysql",
  "mysql2",
  "nodemailer",
  "pg",
  "pg-pool",
  "postgres",
  "prisma",
  "redis",
  "resend",
  "sequelize",
  "server-only",
  "sqlite3",
  "stripe",
  "twilio",
  "typeorm",
]

/** `drizzle-orm` is a browser-safe query builder until one of its driver entries is imported. */
const SERVER_SUBPATHS =
  /^drizzle-orm\/(?:node-postgres|postgres-js|mysql2|better-sqlite3|libsql|bun-sqlite|neon-serverless|neon-http|vercel-postgres|planetscale-serverless|d1|pglite)(?:\/|$)/

/** The nifra marker a module imports to refuse the browser outright. */
export const BACKEND_ONLY_MARKER = "@nifrajs/web/backend-only"

const SOURCE = "(?:[cm]?[jt]sx?|svelte|vue|mdx)"
/** A route's backend half: `x.backend.ts`. Script extensions only; JSX belongs to the frontend half. */
export const ROUTE_BACKEND_FILE = /\.backend\.(?:[cm]?[jt]s)$/
const ZONE_SUFFIX = new RegExp(`\\.(frontend|backend|shared|fn)\\.${SOURCE}$`)
const LEGACY_SERVER_SUFFIX = new RegExp(`\\.server\\.${SOURCE}$`)
export const SERVER_COMPONENT_FILE = /\.component\.server\.[cm]?[jt]sx?$/

const ZONE_FOLDERS: Readonly<Record<string, Zone>> = {
  frontend: "frontend",
  backend: "backend",
  shared: "shared",
  public: "frontend",
}

export interface ZoneClassifierOptions {
  /** The app root: the directory holding `routes/`, `frontend/`, `backend/` and `shared/`. */
  readonly appRoot: string
  /** The routes directory (default `<appRoot>/routes`). */
  readonly routesDir?: string
  /** Extra absolute files treated as `generated` - a build's own entry modules. */
  readonly generatedFiles?: readonly string[]
  /** The app's zone settings. Default: `"nifra": { "zones": ... }` in the app's package.json. */
  readonly zones?: ZoneConfig
}

/**
 * App-side zone settings, read from `"nifra": { "zones": ... }` in the app's package.json so every
 * build, dev server, `nifra check` and the editor plugin see the same ones without running app code.
 */
export interface ZoneConfig {
  /**
   * The side of a package that does not declare one in its own package.json, by name: exact
   * (`"@shop/db"`) or a trailing-`*` prefix (`"@shop/*"`). The exact name wins over a prefix, the
   * longest prefix over a shorter one, and a package's own declaration over all of them.
   */
  readonly packages?: Readonly<Record<string, PackageEnvironment>>
  /**
   * App-relative folders or files holding backend code, beside `backend/` (`"migrations"`). A path
   * listed inside another one's folder overrides it: the most specific entry wins.
   */
  readonly backend?: readonly string[]
  /** App-relative folders or files holding frontend code, beside `frontend/`. */
  readonly frontend?: readonly string[]
  /** App-relative folders or files holding code both sides import, beside `shared/`. */
  readonly shared?: readonly string[]
}

/** A `"nifra": { "zones": ... }` setting that cannot be applied. Thrown when a classifier is created. */
export class ZoneConfigError extends Error {
  override readonly name = "ZoneConfigError"
  /** The file holding the setting, as the caller named it. */
  readonly source: string
  constructor(source: string, problem: string) {
    super(`[nifra] ${source} "nifra.zones": ${problem}`)
    this.source = source
  }
}

const FOLDER_SIDES = ["backend", "frontend", "shared"] as const
const FOLDER_SIDE_NAMES: ReadonlySet<string> = new Set(FOLDER_SIDES)
const isPackageEnvironment = (value: unknown): value is PackageEnvironment =>
  typeof value === "string" && PACKAGE_ENVIRONMENTS.has(value)
const RESERVED_FOLDERS: ReadonlySet<string> = new Set([
  "routes",
  "frontend",
  "backend",
  "shared",
  "public",
  "node_modules",
])

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined

/**
 * Validate a `zones` setting. `source` names where it came from in the error. Folders and files are
 * plain app-relative paths (a trailing `/**` is accepted and dropped); any other glob is refused, so
 * a pattern can never match less than its author meant without saying so. One path under two sides
 * is refused; a path nested in another's folder is not, since the most specific one decides.
 */
export function parseZoneConfig(value: unknown, source: string): ZoneConfig {
  const fail = (message: string): never => {
    throw new ZoneConfigError(source, message)
  }
  const record = recordOf(value) ?? fail("must be an object")
  const config: {
    packages?: Record<string, PackageEnvironment>
    backend?: string[]
    frontend?: string[]
    shared?: string[]
  } = {}
  for (const key of Object.keys(record)) {
    if (key !== "packages" && !FOLDER_SIDE_NAMES.has(key))
      fail(`unknown key "${key}" (expected packages, backend, frontend or shared)`)
  }
  if (record.packages !== undefined) {
    const packages = recordOf(record.packages) ?? fail('"packages" must be an object')
    const parsed: Record<string, PackageEnvironment> = {}
    for (const [pattern, side] of Object.entries(packages)) {
      if (pattern === "" || pattern.indexOf("*") !== pattern.lastIndexOf("*"))
        fail(`package pattern "${pattern}" must be a name, or a name prefix ending in one "*"`)
      if (pattern.includes("*") && !pattern.endsWith("*"))
        fail(`package pattern "${pattern}" may use "*" only at its end`)
      parsed[pattern] = isPackageEnvironment(side)
        ? side
        : fail(`packages["${pattern}"] must be one of frontend, backend, shared, library`)
    }
    config.packages = parsed
  }
  const owner = new Map<string, string>()
  for (const side of FOLDER_SIDES) {
    const raw = record[side]
    if (raw === undefined) continue
    const entries: readonly unknown[] = Array.isArray(raw)
      ? raw
      : fail(`"${side}" must be an array of app-relative folders or files`)
    const folders: string[] = []
    for (const entry of entries) {
      const folder = (typeof entry === "string" ? entry : fail(`"${side}" must hold strings`))
        .replaceAll("\\", "/")
        .replace(/^\.\//, "")
        .replace(/\/\*\*$/, "")
        .replace(/\/+$/, "")
      const top = folder.split("/")[0] ?? ""
      if (folder === "" || folder.startsWith("/") || /^[a-z]:/i.test(folder))
        fail(`"${side}" entry "${entry}" must be a folder or file relative to the app`)
      if (folder.split("/").includes("..")) fail(`"${side}" entry "${entry}" may not contain ".."`)
      if (/[*?[\]{}!]/.test(folder))
        fail(`"${side}" entry "${entry}" must be a plain path (a trailing "/**" is allowed)`)
      if (RESERVED_FOLDERS.has(top) || top.startsWith(".nifra"))
        fail(`"${side}" entry "${entry}" is inside ${top}/, which already has its own rules`)
      const other = owner.get(folder)
      if (other !== undefined && other !== side)
        fail(`"${folder}" is listed as both ${other} and ${side}; a path has one side`)
      owner.set(folder, side)
      folders.push(folder)
    }
    config[side] = folders
  }
  return config
}

/** The `nifra.zones` of the nearest package.json at or above `appRoot`, validated. */
function appZoneConfig(appRoot: string): ZoneConfig {
  let dir = appRoot
  for (;;) {
    const manifest = join(dir, "package.json")
    if (existsSync(manifest)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(manifest, "utf8"))
      } catch {
        return {}
      }
      const zones = recordOf(recordOf(parsed)?.nifra)?.zones
      return zones === undefined ? {} : parseZoneConfig(zones, toPosix(manifest))
    }
    const parent = dirname(dir)
    if (parent === dir) return {}
    dir = parent
  }
}

/** The side `packages` gives `name`: the exact entry, else the longest matching prefix. */
function mappedSide(
  packages: Readonly<Record<string, PackageEnvironment>> | undefined,
  name: string | undefined,
): PackageEnvironment | undefined {
  if (packages === undefined || name === undefined) return undefined
  const exact = packages[name]
  if (exact !== undefined && Object.hasOwn(packages, name)) return exact
  let best: string | undefined
  for (const pattern of Object.keys(packages)) {
    if (!pattern.endsWith("*") || !name.startsWith(pattern.slice(0, -1))) continue
    if (best === undefined || pattern.length > best.length) best = pattern
  }
  return best === undefined ? undefined : packages[best]
}

/** How the `packages` setting would name `name`: its scope wildcard when it has a scope. */
const suggestedPattern = (name: string): string =>
  name.startsWith("@") && name.includes("/") ? `${name.slice(0, name.indexOf("/"))}/*` : name

export interface ZoneClassifier {
  readonly appRoot: string
  /**
   * Classify a file by its absolute (or appRoot-relative) path. Results are cached per path.
   *
   * With `specifier`, the import as written that resolved to `file`: when it names a package that
   * gives each export entry its own side (`"nifra": { "environment": { ".": "backend", "./react":
   * "frontend" } }`), the entry it names decides, since two entries may share one file. A specifier
   * naming an entry the map leaves out is an error. The resolved file must belong to that entry, as
   * the package's own imports reach it; one only other entries reach is judged by its path.
   */
  classify(file: string, specifier?: string): Classification
}

const toPosix = (path: string): string => path.replaceAll("\\", "/")

// `generateServerManifest`'s first line. The manifest composes both halves of every route, so it
// imports frontend code from wherever the build wrote it - next to the server entry, often backend/.
const GENERATED_SERVER_MANIFEST = "// GENERATED by @nifrajs/web generateServerManifest"
const SERVER_MANIFEST_FILE = /^server-manifest\.[cm]?[jt]s$/

function isGeneratedServerManifest(file: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(file, "r")
    const head = Buffer.alloc(GENERATED_SERVER_MANIFEST.length)
    const read = readSync(fd, head, 0, head.length, 0)
    return head.toString("utf8", 0, read) === GENERATED_SERVER_MANIFEST
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** The real path of a file, or the normalized input when it does not exist on disk. */
function realFile(path: string): string {
  try {
    return toPosix(realpathSync.native(path))
  } catch {
    // A path that does not exist yet keeps its directory's real spelling, so it still compares with
    // the paths around it: a Windows short name or a symlinked temp dir spells one directory two ways.
    const parent = dirname(path)
    if (parent === path) return toPosix(path)
    const real = realFile(parent)
    return `${real.endsWith("/") ? real : `${real}/`}${basename(path)}`
  }
}

const isInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`)

/** `@scope/name` or `name` from the LAST `node_modules/` segment of a path. */
function nodeModulesPackage(path: string): string | undefined {
  const at = path.lastIndexOf("/node_modules/")
  if (at === -1) return undefined
  const parts = path.slice(at + "/node_modules/".length).split("/")
  const first = parts[0]
  if (first === undefined || first === "") return undefined
  return first.startsWith("@") && parts[1] !== undefined ? `${first}/${parts[1]}` : first
}

interface PackageInfo {
  readonly dir: string
  readonly name: string | undefined
  readonly declaration: EnvironmentDeclaration
  readonly manifest: Readonly<Record<string, unknown>>
}

const DECLARATION_FILE = /\.d\.[cm]?ts$/

/** The one side a file reached by several mapped entries takes: what each entry's importers may import. */
function ownersSide(owners: ReadonlySet<PackageEnvironment>): PackageEnvironment {
  const [only] = owners
  if (owners.size === 1 && only !== undefined) return only
  return owners.has("library") || (owners.has("frontend") && owners.has("backend"))
    ? "library"
    : "shared"
}

/**
 * Create a classifier for one app. Cheap to create; it caches per file and per package directory,
 * so build plugins and dev servers keep one for the life of a build or a session.
 */
export function createZoneClassifier(options: ZoneClassifierOptions): ZoneClassifier {
  const appRoot = realFile(resolve(options.appRoot))
  const routesDir = realFile(resolve(options.routesDir ?? join(options.appRoot, "routes")))
  const generated = new Set((options.generatedFiles ?? []).map((file) => realFile(resolve(file))))
  const zones =
    options.zones === undefined
      ? appZoneConfig(appRoot)
      : parseZoneConfig(options.zones, "ZoneClassifierOptions")
  const configuredFolders: Array<readonly [string, "backend" | "frontend" | "shared"]> = []
  for (const side of FOLDER_SIDES)
    for (const folder of zones[side] ?? []) configuredFolders.push([folder, side])
  // Longest first, so the most specific entry covering a file decides its side.
  configuredFolders.sort(([a], [b]) => b.length - a.length)
  const configuredPath = (
    rel: string,
  ): readonly [string, "backend" | "frontend" | "shared"] | undefined =>
    configuredFolders.find(([folder]) => rel === folder || rel.startsWith(`${folder}/`))
  const cache = new Map<string, Classification>()
  const packages = new Map<string, PackageInfo | null>()

  /** The nearest `package.json` at or above `dir`, cached by directory. */
  const packageFor = (dir: string): PackageInfo | undefined => {
    const seen: string[] = []
    let current = dir
    for (;;) {
      const cached = packages.get(current)
      if (cached !== undefined) {
        for (const visited of seen) packages.set(visited, cached)
        return cached ?? undefined
      }
      seen.push(current)
      const manifest = join(current, "package.json")
      if (existsSync(manifest)) {
        let parsed: Readonly<Record<string, unknown>> = {}
        try {
          parsed = recordOf(JSON.parse(readFileSync(manifest, "utf8"))) ?? {}
        } catch {
          // An unreadable manifest declares nothing; the caller reports the missing declaration.
        }
        const info: PackageInfo = {
          dir: current,
          name: typeof parsed.name === "string" ? parsed.name : undefined,
          declaration: parseEnvironment(recordOf(parsed.nifra)?.environment),
          manifest: parsed,
        }
        for (const visited of seen) packages.set(visited, info)
        return info
      }
      const parent = toPosix(dirname(current))
      if (parent === current) {
        for (const visited of seen) packages.set(visited, null)
        return undefined
      }
      current = parent
    }
  }

  const ownerships = new Map<string, EntryOwnership>()
  const ownershipOf = (
    info: PackageInfo,
    entries: Readonly<Record<string, PackageEnvironment>>,
  ): EntryOwnership => {
    let found = ownerships.get(info.dir)
    if (found === undefined) {
      found = entryOwnership(info.dir, info.manifest, entries)
      ownerships.set(info.dir, found)
    }
    return found
  }

  /** The package `file` is part of, when that package is not the app: installed, or a workspace sibling. */
  const packageOf = (file: string): PackageInfo | undefined => {
    const thirdParty = nodeModulesPackage(file)
    if (thirdParty !== undefined) {
      const at = file.lastIndexOf("/node_modules/") + "/node_modules/".length
      return packageFor(file.slice(0, at + thirdParty.length))
    }
    return isInside(file, appRoot) ? undefined : packageFor(toPosix(dirname(file)))
  }

  /** What a side declared for `file` (by its package, an entry of it, or the app) makes it. */
  const declaredAs = (
    file: string,
    info: PackageInfo | undefined,
    side: PackageEnvironment,
    entry?: string,
  ): Classification => {
    const thirdParty = nodeModulesPackage(file)
    const named = entry === undefined || info?.name === undefined ? {} : { packageName: info.name }
    const decided = entry === undefined ? {} : { entry }
    if (thirdParty !== undefined) {
      return {
        zone: "library",
        packageName: thirdParty,
        modulePath: file.slice(file.lastIndexOf("/node_modules/") + "/node_modules/".length),
        declared: side,
        ...decided,
      }
    }
    if (side !== "library") return { zone: side, ...named, ...decided }
    return {
      zone: "library",
      ...(info?.name ? { packageName: info.name } : {}),
      declared: "library",
      ...decided,
    }
  }

  /** A file of a package that declares a side per entry, judged by the entries that reach it. */
  const byOwners = (
    file: string,
    info: PackageInfo,
    entries: Readonly<Record<string, PackageEnvironment>>,
  ): Classification => {
    const ownership = ownershipOf(info, entries)
    const owners = ownership.owners.get(file)
    if (owners !== undefined) return declaredAs(file, info, ownersSide(owners))
    const shown = nodeModulesPackage(file) === undefined ? file : file.slice(info.dir.length + 1)
    const left =
      ownership.unmapped.length === 0
        ? ""
        : ` (the map leaves out ${ownership.unmapped.map((key) => `"${key}"`).join(", ")})`
    return {
      zone: "error",
      reason: `"${shown}" is in package "${info.name ?? info.dir}", whose "nifra.environment" gives each entry its own side, and no mapped entry reaches this file${left}. Import the package through a mapped entry`,
    }
  }

  const invalidDeclaration = (info: PackageInfo, problem: string): Classification => {
    const reason = `${info.dir}/package.json "nifra.environment": ${problem}`
    return info.name === undefined
      ? { zone: "error", reason }
      : { zone: "error", reason, package: info.name }
  }

  const classifyUncached = (file: string): Classification => {
    if (generated.has(file)) return { zone: "generated" }
    const thirdParty = nodeModulesPackage(file)
    if (thirdParty !== undefined) {
      const info = packageOf(file)
      const declaration = info?.declaration ?? { kind: "none" }
      if (info !== undefined && declaration.kind === "invalid")
        return invalidDeclaration(info, declaration.problem)
      if (info !== undefined && declaration.kind === "entries")
        return byOwners(file, info, declaration.entries)
      const declared =
        declaration.kind === "package" ? declaration.side : mappedSide(zones.packages, thirdParty)
      return {
        zone: "library",
        packageName: thirdParty,
        modulePath: file.slice(file.lastIndexOf("/node_modules/") + "/node_modules/".length),
        ...(declared ? { declared } : {}),
      }
    }
    const base = file.slice(file.lastIndexOf("/") + 1)
    if (isInside(file, appRoot)) {
      if (SERVER_MANIFEST_FILE.test(base) && isGeneratedServerManifest(file)) {
        return { zone: "generated" }
      }
      if (SERVER_COMPONENT_FILE.test(base)) return { zone: "component" }
      if (/\.island\.[cm]?[jt]sx?$/.test(base)) return { zone: "frontend" }
      if (LEGACY_SERVER_SUFFIX.test(base)) {
        return {
          zone: "error",
          reason: `"${relativeTo(appRoot, file)}" uses the retired ".server" suffix. Rename it to ".backend" (or move it under backend/); nifra no longer empties .server modules in the browser build`,
        }
      }
      const rel = relativeTo(appRoot, file)
      const top = rel.split("/")[0] ?? ""
      if (top.startsWith(".nifra")) return { zone: "generated" }
      const suffix = ZONE_SUFFIX.exec(base)?.[1] as
        | "frontend"
        | "backend"
        | "shared"
        | "fn"
        | undefined
      // Only a script module is replaced by the calls a browser makes; any other ".fn" file would
      // ship to the browser exactly as written.
      if (suffix === "fn" && !SERVER_FN_MODULE.test(base)) {
        return {
          zone: "error",
          reason: `"${rel}" is named as a server function, but only a script module (.ts, .js) can be one - the browser build would ship this file as it is. Rename it`,
        }
      }
      if (isInside(file, routesDir)) {
        if (ROUTE_BACKEND_FILE.test(base)) return { zone: "route-backend" }
        if (suffix === "fn") return { zone: "fn" }
        if (suffix === "backend") return { zone: "route-backend" }
        if (suffix === "shared") return { zone: "shared" }
        return { zone: "route-frontend" }
      }
      const configured = ZONE_FOLDERS[top] === undefined ? configuredPath(rel) : undefined
      const folder = ZONE_FOLDERS[top] ?? configured?.[1]
      if (folder !== undefined) {
        if (suffix === undefined || suffix === folder) return { zone: folder }
        if (suffix === "fn" && folder === "backend") return { zone: "fn" }
        const where =
          configured === undefined
            ? `sits in ${top}/`
            : configured[0] === rel
              ? `is listed as ${folder} in "nifra.zones"`
              : `sits in ${configured[0]}/, which "nifra.zones" lists as ${folder},`
        return {
          zone: "error",
          reason: `"${rel}" ${where} but its ".${suffix}" suffix says otherwise. A file belongs to one side: move it, or drop the suffix`,
        }
      }
      if (suffix !== undefined) return { zone: suffix === "fn" ? "fn" : suffix }
      return { zone: "error", reason: unzonedReason(rel) }
    }
    // First-party code outside the app: a workspace package, or a relative import out of the app.
    const info = packageFor(toPosix(dirname(file)))
    const declaration = info?.declaration ?? { kind: "none" }
    if (info !== undefined && declaration.kind === "invalid")
      return invalidDeclaration(info, declaration.problem)
    if (info !== undefined && declaration.kind === "entries")
      return byOwners(file, info, declaration.entries)
    const environment =
      declaration.kind === "package" ? declaration.side : mappedSide(zones.packages, info?.name)
    if (environment !== undefined) return declaredAs(file, info, environment)
    const declare = `"nifra": { "environment": "frontend" | "backend" | "shared" | "library" }`
    if (info?.name === undefined) {
      return {
        zone: "error",
        reason: `"${file}" is first-party code outside the app and declares no side. Add ${declare} to ${info === undefined ? "a package.json above it" : `${info.dir}/package.json`}`,
      }
    }
    // Named per package, not per file, so a build that reaches 50 files of it reports one fact once.
    return {
      zone: "error",
      package: info.name,
      reason: `package "${info.name}" is first-party code outside the app and declares no side. Add ${declare} to ${info.dir}/package.json, or give it a side from the app's package.json: "nifra": { "zones": { "packages": { "${suggestedPattern(info.name)}": "backend" } } } (or "library" if the browser may load it)`,
    }
  }

  const byPath = (file: string): Classification => {
    const cached = cache.get(file)
    if (cached !== undefined) return cached
    const result = classifyUncached(file)
    cache.set(file, result)
    return result
  }

  // Keyed by file and subpath: two entries may share one file and declare different sides.
  const imports = new Map<string, Classification>()
  const byImport = (file: string, specifier: string): Classification => {
    const name = specifierPackage(specifier)
    const info = name === undefined ? undefined : packageOf(file)
    if (name === undefined || info?.name !== name || info.declaration.kind !== "entries")
      return byPath(file)
    const subpath = entrySubpath(specifier, name)
    const cacheKey = `${file}\0${subpath}`
    const cached = imports.get(cacheKey)
    if (cached !== undefined) return cached
    const { entries } = info.declaration
    const key = entryKey(entries, subpath)
    const side = key === undefined ? undefined : entries[key]
    let result: Classification
    if (side === undefined) {
      const mapped = Object.keys(entries)
        .map((entry) => `"${entry}"`)
        .join(", ")
      result = {
        zone: "error",
        reason: `"${specifier}" names the "${subpath}" entry of package "${name}", whose "nifra.environment" map gives it no side (it maps ${mapped}). Map the entry, or import one that is mapped`,
        entry: subpath,
      }
    } else {
      // The resolver's pick must belong to the named entry; a file only other entries reach (an alias
      // pointed at it) is judged by its path. A declaration file is types only and erased.
      const owners = ownershipOf(info, entries).owners.get(file)
      result =
        owners !== undefined && !owners.has(side) && !DECLARATION_FILE.test(file)
          ? byPath(file)
          : declaredAs(file, info, side, subpath)
    }
    imports.set(cacheKey, result)
    return result
  }

  return {
    appRoot,
    classify(input: string, specifier?: string): Classification {
      const absolute = isAbsolute(input) ? input : resolve(appRoot, input)
      const file = realFile(absolute)
      return specifier === undefined ? byPath(file) : byImport(file, specifier)
    },
  }
}

function relativeTo(root: string, file: string): string {
  return toPosix(relative(root, file)).split(sep).join("/")
}

const RETIRED_ROOT_FILES: Readonly<Record<string, string>> = {
  "backend.ts": "backend/app.ts",
  "framework.ts": "backend/framework.ts",
}

function unzonedReason(rel: string): string {
  const moved = RETIRED_ROOT_FILES[rel]
  if (moved !== undefined) {
    return `"${rel}" moved: it lives at ${moved} now (run \`nifra migrate layout\`)`
  }
  return `"${rel}" is in no zone. Every file a build loads lives under routes/, frontend/, backend/ or shared/, or carries a .frontend/.backend/.shared suffix`
}

/** The package name a bare specifier names, or `undefined` for a relative path, a builtin, a
 * subpath import (`#x`) or a bundler-virtual id. */
export function specifierPackage(specifier: string): string | undefined {
  if (/^(?:\.|\/|#|\0|[a-z]+:)/i.test(specifier)) return undefined
  if (specifier.startsWith("@") && !/^@[^/]+\/[^/]/.test(specifier)) return undefined
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

/** The export subpath (`"."`, `"./react"`) a bare specifier of package `name` names. */
const entrySubpath = (specifier: string, name: string): string =>
  `.${withoutQuery(specifier.slice(name.length))}`

/**
 * The side a package's `"nifra": { "environment": ... }` value gives the bare import `specifier` of it:
 * the package-wide string, or the side of the entry it names - the map's exact subpath, else its most
 * specific `*` pattern. `undefined` when it gives none, as a map that leaves the entry out does.
 */
export function declaredSide(
  environment: unknown,
  specifier: string,
): PackageEnvironment | undefined {
  const declaration = parseEnvironment(environment)
  if (declaration.kind === "package") return declaration.side
  const name = specifierPackage(specifier)
  if (declaration.kind !== "entries" || name === undefined) return undefined
  const key = entryKey(declaration.entries, entrySubpath(specifier, name))
  return key === undefined ? undefined : declaration.entries[key]
}

/**
 * Why a classified file may not ship to a browser, or `undefined` when it may. A `drizzle-orm` driver
 * entry is recognized by the import as written (`specifier`) or by the file's path in the package.
 */
export function browserDenial(
  classification: Classification,
  specifier?: string,
): string | undefined {
  if (classification.zone === "error") return classification.reason
  if (!BROWSER_ZONES.has(classification.zone)) {
    if (classification.entry !== undefined)
      return `package "${classification.packageName}" declares its "${classification.entry}" entry ${classification.zone}-only`
    return classification.zone === "route-backend"
      ? "it is a route's backend half, which runs on the server only"
      : "it is backend code"
  }
  if (classification.zone !== "library") return undefined
  const name = classification.packageName
  if (classification.declared === "backend") {
    return classification.entry === undefined
      ? `package "${name}" declares itself backend-only`
      : `package "${name}" declares its "${classification.entry}" entry backend-only`
  }
  if (name !== undefined && SERVER_PACKAGES.includes(name)) {
    return `package "${name}" is server code (a driver, server SDK or credential helper)`
  }
  if (specifier !== undefined && SERVER_SUBPATHS.test(specifier)) {
    return `"${specifier}" is a database driver entry`
  }
  const driver = classification.modulePath?.match(SERVER_SUBPATHS)?.[0]
  if (driver !== undefined) return `"${driver.replace(/\/$/, "")}" is a database driver entry`
  return undefined
}

/** Whether a bare specifier names one of {@link SERVER_PACKAGES} or a database driver entry. */
export function isServerPackageSpecifier(specifier: string): boolean {
  const name = specifierPackage(specifier)
  return (name !== undefined && SERVER_PACKAGES.includes(name)) || SERVER_SUBPATHS.test(specifier)
}

/** Whether a module in `from` may import (with a value import) a module in `to`. */
export function importAllowed(from: Zone, to: Zone): boolean {
  if (from === "component") return true
  if (from === "generated" || from === "library") return true
  if (to === "generated" || to === "library") return true
  if (FRONTEND_ZONES.has(from)) return FRONTEND_ZONES.has(to) || to === "shared" || to === "fn"
  if (SERVER_ZONES.has(from)) return !FRONTEND_ZONES.has(to)
  // shared
  return to === "shared"
}

/** The message for an import {@link importAllowed} refuses. */
export function importRuleMessage(fromFile: string, from: Zone, toFile: string, to: Zone): string {
  const side = (zone: Zone): string =>
    zone === "route-frontend"
      ? "a route's frontend half"
      : zone === "route-backend"
        ? "a route's backend half"
        : zone === "fn"
          ? "a server-function module"
          : `${zone} code`
  const hint =
    from === "shared"
      ? "shared code runs on both sides, so it may import only shared code and third-party packages"
      : SERVER_ZONES.has(from)
        ? "backend code may not import frontend code; move what both need into shared/"
        : "frontend code may not import backend code; reach it through a loader, an action or a *.fn.ts server function"
  return `${fromFile} (${side(from)}) imports ${toFile} (${side(to)}): ${hint}. A type-only import (\`import type\`) is allowed`
}

export { isSensitiveFieldName } from "./internal/output-guard.ts"
export { privateEnvReads, privateEnvReason } from "./internal/private-env.ts"
export {
  publicScanFiles,
  type SecretExemption,
  type SecretFinding,
  type SecretRule,
  type SecretScanFile,
  type SecretScanInput,
  scanForSecrets,
} from "./internal/secret-scan.ts"
