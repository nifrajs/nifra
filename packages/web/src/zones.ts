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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { SERVER_FN_MODULE } from "./internal/server-boundary.ts"

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
    }
  | { readonly zone: "error"; readonly reason: string }

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
}

export interface ZoneClassifier {
  readonly appRoot: string
  /** Classify a file by its absolute (or appRoot-relative) path. Results are cached per path. */
  classify(file: string): Classification
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
    return toPosix(path)
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
  readonly environment: string | undefined
}

/**
 * Create a classifier for one app. Cheap to create; it caches per file and per package directory,
 * so build plugins and dev servers keep one for the life of a build or a session.
 */
export function createZoneClassifier(options: ZoneClassifierOptions): ZoneClassifier {
  const appRoot = realFile(resolve(options.appRoot))
  const routesDir = realFile(resolve(options.routesDir ?? join(options.appRoot, "routes")))
  const generated = new Set((options.generatedFiles ?? []).map((file) => realFile(resolve(file))))
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
        let parsed: { name?: unknown; nifra?: { environment?: unknown } } = {}
        try {
          parsed = JSON.parse(readFileSync(manifest, "utf8")) as typeof parsed
        } catch {
          // An unreadable manifest declares nothing; the caller reports the missing declaration.
        }
        const info: PackageInfo = {
          dir: current,
          name: typeof parsed.name === "string" ? parsed.name : undefined,
          environment:
            typeof parsed.nifra?.environment === "string" ? parsed.nifra.environment : undefined,
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

  const classifyUncached = (file: string): Classification => {
    if (generated.has(file)) return { zone: "generated" }
    const thirdParty = nodeModulesPackage(file)
    if (thirdParty !== undefined) {
      const info = packageFor(toPosix(dirname(file)))
      const declared =
        info?.environment !== undefined && PACKAGE_ENVIRONMENTS.has(info.environment)
          ? (info.environment as PackageEnvironment)
          : undefined
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
      const folder = ZONE_FOLDERS[top]
      if (folder !== undefined) {
        if (suffix === undefined || suffix === folder) return { zone: folder }
        if (suffix === "fn" && folder === "backend") return { zone: "fn" }
        return {
          zone: "error",
          reason: `"${rel}" sits in ${top}/ but its ".${suffix}" suffix says otherwise. A file belongs to one side: move it, or drop the suffix`,
        }
      }
      if (suffix !== undefined) return { zone: suffix === "fn" ? "fn" : suffix }
      return { zone: "error", reason: unzonedReason(rel) }
    }
    // First-party code outside the app: a workspace package, or a relative import out of the app.
    const info = packageFor(toPosix(dirname(file)))
    const environment = info?.environment
    if (environment !== undefined && PACKAGE_ENVIRONMENTS.has(environment)) {
      return environment === "library"
        ? {
            zone: "library",
            ...(info?.name ? { packageName: info.name } : {}),
            declared: "library",
          }
        : { zone: environment as Zone }
    }
    const where = info?.name ?? info?.dir ?? dirname(file)
    return {
      zone: "error",
      reason: `"${file}" is first-party code outside the app (${where}) and declares no side. Add "nifra": { "environment": "frontend" | "backend" | "shared" | "library" } to ${info === undefined ? "its package.json" : `${info.dir}/package.json`}`,
    }
  }

  return {
    appRoot,
    classify(input: string): Classification {
      const absolute = isAbsolute(input) ? input : resolve(appRoot, input)
      const file = realFile(absolute)
      const cached = cache.get(file)
      if (cached !== undefined) return cached
      const result = classifyUncached(file)
      cache.set(file, result)
      return result
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
    return classification.zone === "route-backend"
      ? "it is a route's backend half, which runs on the server only"
      : "it is backend code"
  }
  if (classification.zone !== "library") return undefined
  const name = classification.packageName
  if (classification.declared === "backend") return `package "${name}" declares itself backend-only`
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

/** Whether a module in `from` may import (with a value import) a module in `to`. */
export function importAllowed(from: Zone, to: Zone): boolean {
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
