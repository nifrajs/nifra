/**
 * The `nifra dev --bun` boundary-plugin channel.
 *
 * Bun's dev-server bundling (`Bun.serve` HTML imports) accepts plugins ONLY through bunfig's
 * `[serve.static] plugins` - there is no programmatic option (upstream ask: oven-sh/bun#36830), and
 * a runtime `Bun.plugin()` never reaches it. Without a plugin there, a `*.fn` server-function module
 * would ship to the browser WHOLE (body, DB handles, secrets) instead of as the RPC stub the
 * production client build emits, and a `*.server` module would ship instead of being emptied.
 *
 * The same channel is the only way an app's OWN `clientPlugins` (SFC compilers and the like) can reach
 * that bundler: the CLI holds them as plugin OBJECTS, and bunfig accepts only module paths - so the
 * generated module re-imports the app's config and composes them in.
 *
 * So the CLI generates, under `.nifra/dev-bun/`:
 *   - `boundary-plugin.ts` - default-exports one plugin composing the SAME `serverFnStubPlugin` +
 *     `serverOnlyEmptyPlugin` + CSS Modules transform the production build uses (imported from
 *     `@nifrajs/web`, resolved from the app - identical transforms, not re-implementations), plus the
 *     app's own `clientPlugins`;
 *   - `bunfig.toml` - the app's ENTIRE bunfig carried over verbatim (jsx, loaders, defines, install
 *     settings - dropping any of them would give dev a different Bun than the app configured), with
 *     `[serve.static] plugins` merged to put the boundary plugin first and path-bearing entries
 *     (`preload`, plugin paths) re-rooted at the app, because bunfig resolves relative entries
 *     against the CONFIG file's directory;
 *   - `launch-token` - a per-launch random value (see below).
 *
 * `dev --bun` then re-execs itself once with `--config=<generated>` (bunfig is read at process
 * start, so the already-running CLI can't adopt it) - see `cli.ts`.
 *
 * ## Why a random launch token, not a fixed marker
 *
 * The child must know it IS the configured child. A fixed sentinel (`SOME_VAR=1`) would let any
 * inherited environment - a CI wrapper, a shell profile, another tool - satisfy the check and skip
 * the config generation entirely, serving the app with NO boundary plugins: a silent secret leak
 * switched on by an environment variable. So the parent mints a fresh `crypto.randomUUID()` per
 * launch, writes it beside the generated config, and passes it in the child's env; the child accepts
 * only a token that matches the file, and CONSUMES the file on first read so a stale env value can
 * never satisfy a later launch. An unverifiable token means the process acts as a parent and
 * regenerates - fail closed, never serve unproven.
 */
import { timingSafeEqual } from "node:crypto"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { relative, resolve } from "node:path"

/** TOML string literal: basic (double-quoted) form with the two escapes it needs. */
function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

/** A parsed bunfig: plain data from `Bun.TOML.parse`. */
type BunfigData = Record<string, unknown>

/** Parse the app's bunfig. Malformed TOML fails LOUDLY with the parse error - silently treating a
 * broken config as empty would run dev with different Bun settings than the app declares. */
export function parseUserBunfig(toml: string | undefined): BunfigData {
  if (toml === undefined) return {}
  try {
    return (Bun.TOML.parse(toml) ?? {}) as BunfigData
  } catch (err) {
    throw new Error(
      `[nifra] the app's bunfig.toml does not parse, so \`nifra dev --bun\` cannot carry it into ` +
        `the dev server's config: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/
const tomlKey = (key: string): string => (BARE_KEY.test(key) ? key : tomlString(key))

function tomlValue(value: unknown, path: string): string {
  if (typeof value === "string") return tomlString(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    return `[${value.map((item, i) => tomlValue(item, `${path}[${i}]`)).join(", ")}]`
  }
  throw new Error(
    `[nifra] bunfig field \`${path}\` has a shape \`nifra dev --bun\` cannot re-serialize ` +
      `(supported: strings, numbers, booleans, arrays of those, and nested tables). ` +
      `Move it out of bunfig.toml for the Bun dev loop, or report the shape.`,
  )
}

const isTable = (value: unknown): value is BunfigData =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Serialize a parsed bunfig back to TOML: scalar/array keys first, then nested tables as dotted
 * `[section]` headers, recursively. Every field round-trips or the serializer throws - a field
 * silently dropped here would be a dev server running different Bun settings than the app's. */
export function serializeBunfig(data: BunfigData): string {
  const lines: string[] = []
  const walk = (table: BunfigData, prefix: string): void => {
    const scalars = Object.entries(table).filter(([, v]) => !isTable(v))
    const tables = Object.entries(table).filter((entry): entry is [string, BunfigData] =>
      isTable(entry[1]),
    )
    if (prefix !== "" && scalars.length > 0) lines.push(`[${prefix}]`)
    for (const [key, value] of scalars) {
      lines.push(`${tomlKey(key)} = ${tomlValue(value, prefix === "" ? key : `${prefix}.${key}`)}`)
    }
    for (const [key, value] of tables) {
      const next = prefix === "" ? tomlKey(key) : `${prefix}.${tomlKey(key)}`
      // A table with ONLY sub-tables still needs no header of its own; recursion emits the leaves.
      walk(value, next)
    }
  }
  walk(data, "")
  return `${lines.join("\n")}\n`
}

/** Render the generated bunfig: the user's config carried whole, with the boundary plugin prepended
 * to `[serve.static] plugins` and path-bearing entries (`preload`, plugin paths) re-rooted at the
 * APP - bunfig resolves relative entries against the config file's own directory, which is
 * `.nifra/dev-bun/`. */
export function renderDevBunfig(
  boundaryPluginPath: string,
  user: BunfigData,
  appRoot: string,
): string {
  const resolveEntry = (entry: unknown): unknown =>
    typeof entry === "string" && entry.startsWith(".") ? resolve(appRoot, entry) : entry
  const data: BunfigData = structuredClone(user)
  if (data.preload !== undefined) {
    const entries = Array.isArray(data.preload) ? data.preload : [data.preload]
    data.preload = entries.map(resolveEntry)
  }
  const serve = isTable(data.serve) ? data.serve : {}
  data.serve = serve
  const serveStatic = isTable(serve.static) ? serve.static : {}
  serve.static = serveStatic
  const existing = Array.isArray(serveStatic.plugins) ? serveStatic.plugins : []
  serveStatic.plugins = [boundaryPluginPath, ...existing.map(resolveEntry)]
  return (
    "# Generated by `nifra dev --bun` - do not edit. Regenerated on every dev start.\n" +
    "# The app's own bunfig is carried over verbatim; [serve.static] plugins additionally deliver\n" +
    "# the client-boundary plugins (server-fn stubs, server-only emptying) to Bun's dev-server\n" +
    "# bundler, which only accepts plugins via this channel (oven-sh/bun#36830).\n" +
    serializeBunfig(data)
  )
}

/** A TS/JS import specifier for `target` as seen from `fromDir`, always `./`-prefixed and posix-slashed
 * so it reads as a FILE path to the module loader rather than a package name. */
function relativeSpecifier(fromDir: string, target: string): string {
  const rel = relative(fromDir, target).replaceAll("\\", "/")
  return rel.startsWith(".") ? rel : `./${rel}`
}

/**
 * The generated plugin module: compose the production boundary plugins, the production CSS Modules
 * transform, and the APP's own `clientPlugins` into one default export.
 *
 * The `@nifrajs/*` specifiers are bare so they resolve from the APP's install (the module lives under
 * the app's `.nifra/`), keeping dev transforms byte-identical to production's.
 *
 * `configPath` is the app's `nifra.config.ts` (or `framework.ts`). Importing it here is the only way an
 * app's `clientPlugins` can reach Bun's dev-server bundler at all: that bundler takes plugins as module
 * PATHS via bunfig, never as the plugin objects the CLI already holds in memory. Without this an app
 * whose transforms live in `clientPlugins` had no working Bun dev loop - its client would be bundled
 * with the transform silently missing. `setup` is async because `clientPlugins` may be a thunk.
 */
export function renderBoundaryPluginModule(configPath?: string, pluginDir?: string): string {
  const appImport =
    configPath !== undefined && pluginDir !== undefined
      ? `import * as appConfig from ${tomlString(relativeSpecifier(pluginDir, configPath))}\n`
      : ""
  const appSetup =
    appImport === ""
      ? ""
      : `    // The app's OWN client transforms (SFC compilers etc.). \`clientPlugins\` may be a thunk.
    const field = appConfig.clientPlugins
    const appPlugins = (typeof field === "function" ? await field() : field) ?? []
    for (const p of appPlugins) await p.setup(build)
`
  return `// Generated by \`nifra dev\` (Bun pipeline) - do not edit. Regenerated on every dev start.
import { serverFnStubPlugin, serverOnlyEmptyPlugin } from "@nifrajs/web/build"
import { cssModulesBunPlugin } from "@nifrajs/web/plugins/css-modules"
${appImport}
const fn = serverFnStubPlugin()
const serverOnly = serverOnlyEmptyPlugin()
const cssModules = cssModulesBunPlugin("dom")

export default {
  name: "nifra-dev-boundary",
  async setup(build) {
    // Boundary first: an app plugin must never get to transform a module that the boundary is about to
    // empty or stub, or the transform decides what ships instead of the boundary.
    serverOnly.setup(build)
    fn.setup(build)
    cssModules.setup(build)
${appSetup}  },
}
`
}

export interface BunDevConfig {
  readonly bunfigPath: string
  /** Per-launch random value the re-exec'd child must present (and the file copy it must match). */
  readonly launchToken: string
}

const TOKEN_FILE = "launch-token"

/** Write the generated config for an app; returns the bunfig path to re-exec with and the fresh
 * launch token to pass in the child's environment. `configPath` (the app's `nifra.config.ts` /
 * `framework.ts`) is what lets the app's own `clientPlugins` reach Bun's dev-server bundler. */
export async function writeBunDevConfig(
  appRoot: string,
  configPath?: string,
): Promise<BunDevConfig> {
  const dir = resolve(appRoot, ".nifra", "dev-bun")
  mkdirSync(dir, { recursive: true })
  const pluginPath = resolve(dir, "boundary-plugin.ts")
  writeFileSync(pluginPath, renderBoundaryPluginModule(configPath, dir))
  const userToml = await Bun.file(resolve(appRoot, "bunfig.toml"))
    .text()
    .catch(() => undefined)
  const bunfigPath = resolve(dir, "bunfig.toml")
  writeFileSync(bunfigPath, renderDevBunfig(pluginPath, parseUserBunfig(userToml), appRoot))
  const launchToken = crypto.randomUUID()
  writeFileSync(resolve(dir, TOKEN_FILE), launchToken)
  return { bunfigPath, launchToken }
}

/**
 * Child-side proof of a configured launch: the presented token must match the token file the parent
 * just wrote, compared in constant time. The file is CONSUMED (deleted) on the first attempt either
 * way, so a stale environment value can never satisfy a later launch. `false` means this process
 * cannot prove the boundary config is active and must act as a parent (regenerate + re-exec) - the
 * fail-closed direction.
 */
export function consumeLaunchToken(appRoot: string, presented: string | undefined): boolean {
  if (presented === undefined || presented === "") return false
  const path = resolve(appRoot, ".nifra", "dev-bun", TOKEN_FILE)
  let stored: string
  try {
    stored = readFileSync(path, "utf8")
  } catch {
    return false
  }
  try {
    unlinkSync(path)
  } catch {
    // Already consumed by a race - the comparison below still decides on the bytes read.
  }
  const a = Buffer.from(stored)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}
