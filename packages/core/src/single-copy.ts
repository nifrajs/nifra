/**
 * One physical copy of an identity-sensitive package, enforced at LOAD time.
 *
 * ## The gap this closes
 *
 * `@nifrajs/web`'s build already pins react/preact/svelte to the app's copy through `onResolve`
 * (`reactDedupePlugin` and friends), and that covers every bundled phase. It cannot cover an
 * UNBUNDLED one: Bun's runtime plugin API delivers only the entry point and RELATIVE specifiers to
 * `onResolve`, so a bare `import "react"` inside a linked package never reaches a resolver hook. The
 * surfaces that run app sources unbundled - `bun test`, a preloaded script, a route imported natively
 * - therefore keep loading a second copy no matter what the build does. `onLoad` DOES fire on the
 * resolved file, which is the one hook that can still intervene, and it is what this module uses.
 *
 * It also covers a package class the build plugins never did: `@nifrajs/*` itself. Two copies of
 * `@nifrajs/core` are two `Server` classes, and `Server` carries private members, so `.merge()` stops
 * accepting the other's app with a type error that names neither copy.
 *
 * ## Why a topology needs it at all
 *
 * A package consumed with `link:` (or `file:`, or an `npm link`) resolves ITS OWN imports from where
 * it physically lives. A shared component library in a sibling repository therefore loads that
 * repository's react, while the app loads its own - same version, two paths, two module registries.
 * React reads hooks off a dispatcher the other copy never set, and SSR dies with `Invalid hook call
 * … resolveDispatcher() is null`, naming neither react nor the package that shadowed it.
 *
 * The conventional fixes both cost something real: a cross-repo `workspaces` entry makes the
 * consumer's install the owner of the other repository's tree and writes into it, and vendoring or
 * packing copies files that exist precisely so they are not copied. This module is the third option -
 * leave the topology alone and make the resolution answer correctly - and it is not a workaround:
 * these packages declare react as a `peerDependency`, which means "the consumer supplies the copy".
 * That sentence has simply never been enforceable at runtime. Now it is.
 *
 * ## What it will not do
 *
 * Redirect across a VERSION difference. Two versions is a different defect (someone's range is wrong)
 * and silently serving 19.2.8 to a package that asked for 19.2.7 turns a loud install problem into a
 * quiet behavioural one. A version skew is left untouched, so `nifra check` still fails it.
 *
 * @example Declare it in package.json, then preload the registrar in bunfig.toml.
 * ```json
 * { "nifra": { "singleCopy": ["react", "react-dom", "@nifrajs/*"] } }
 * ```
 * ```toml
 * preload = ["@nifrajs/core/single-copy/register"]
 * [test]
 * preload = ["@nifrajs/core/single-copy/register"]
 * ```
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import type { BunPlugin } from "bun"

/**
 * Packages whose duplication is a defect rather than a waste. Each keeps module-scoped state that
 * every importer must share - a hook dispatcher, a renderer's options global, a class identity - so a
 * second physical copy breaks behaviour instead of merely costing bytes. Anything scoped `@nifrajs/`
 * qualifies for the same reason and is matched by pattern.
 */
export const IDENTITY_SENSITIVE_PACKAGES: readonly string[] = [
  "@nifrajs/*",
  "react",
  "react-dom",
  "preact",
  "solid-js",
  "svelte",
  "vue",
]

/** Files a redirect may rewrite. Everything else in a package (json, css, wasm) loads unchanged. */
const REDIRECTABLE = /\.(?:m|c)?[jt]sx?$/
/** Runaway guards. A real `node_modules` top level is hundreds of entries, a repo walk is a few. */
const MAX_SCANNED_ENTRIES = 4_096
const MAX_ANCESTOR_DIRS = 16
const MAX_REPO_DEPTH = 8

export type SingleCopySkipReason = "version-skew" | "no-counterpart"

/** One foreign copy that will be redirected into the app's copy. */
export interface SingleCopyRedirect {
  readonly package: string
  /** Absolute realpath of the copy that loses - the one a linked package would otherwise load. */
  readonly from: string
  /** Absolute realpath of the copy that wins - the one resolvable from the app root. */
  readonly to: string
  readonly version: string
}

/** A foreign copy deliberately left alone, and why - never silently dropped. */
export interface SingleCopySkip {
  readonly package: string
  readonly from: string
  readonly reason: SingleCopySkipReason
  readonly detail: string
}

export interface SingleCopyPlan {
  /** The app root whose installed copy wins. */
  readonly root: string
  /** Declared package names and patterns, as written. */
  readonly declared: readonly string[]
  readonly redirects: readonly SingleCopyRedirect[]
  readonly skipped: readonly SingleCopySkip[]
}

export interface SingleCopyOptions {
  /** The app root whose copy wins. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /** Package names or `@scope/*` patterns. Defaults to the `nifra.singleCopy` declaration. */
  readonly packages?: readonly string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readJsonSync = (path: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

const realpathOrSelf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const inside = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

/**
 * The declaration, read from `package.json` - deliberately NOT from `nifra.config.ts`.
 *
 * `nifra check` holds a pre-load invariant: it never imports the app's config, because importing is
 * executing. A dedupe claim has to be verifiable by a checker that refuses to run the app, so it lives
 * in the one file every tool already parses. `true` means the built-in identity-sensitive set.
 */
export function readSingleCopyDeclaration(cwd: string): readonly string[] | undefined {
  const pkg = readJsonSync(join(resolve(cwd), "package.json"))
  const nifra = pkg?.nifra
  if (!isRecord(nifra)) return undefined
  const declared = nifra.singleCopy
  if (declared === true) return IDENTITY_SENSITIVE_PACKAGES
  if (declared === false || declared === undefined) return undefined
  if (!Array.isArray(declared)) return undefined
  const names = declared.filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  )
  return names.length > 0 ? names : undefined
}

/**
 * Match a package name against a declaration entry: an exact name, or a `@scope/*` prefix.
 *
 * Exported because the enforcement and the CHECK must agree on it exactly. If `nifra check` decided
 * coverage by its own rule, a package could be reported as deduplicated while the plugin walked past
 * it - which is worse than no check at all, because it is a green light for a broken graph.
 */
export const matchesSingleCopyDeclaration = (declared: readonly string[], name: string): boolean =>
  declared.some((entry) =>
    entry.endsWith("/*") ? name.startsWith(entry.slice(0, -1)) : entry === name,
  )

/** The public specifier a `bunfig.toml` preload must name to arm the runtime. */
export const SINGLE_COPY_REGISTER_SPECIFIER = "@nifrajs/core/single-copy/register"

/** Which unbundled phases have the resolver preloaded. Bundled phases never need it - nifra's build
 * injects the plugin itself. */
export interface SingleCopyRegistration {
  /** `preload` at the top level: covers `bun run` and anything that loads app sources directly. */
  readonly run: boolean
  /** `[test] preload`: covers `bun test`, the surface that runs app sources unbundled. */
  readonly test: boolean
  /** The `bunfig.toml` that was read, if one exists. */
  readonly config?: string
}

/** Every `preload = [...]` assignment, tagged with the section it appears under. */
const PRELOAD_ASSIGNMENT =
  /^\s*(?:\[(?<section>[^\]]+)\]|preload\s*=\s*(?<value>\[[^\]]*\]|.+))\s*$/

/**
 * The exact entries of a `preload` assignment: a single-line array, or one quoted string.
 *
 * A substring test on the raw assignment is not proof. `preload =
 * ["@nifrajs/core/single-copy/register-extra"]` contains the specifier and satisfies an
 * `includes()`, while Bun loads that other module and the registrar never runs - the check then
 * reports single-copy enforcement as armed on a process that still loads both copies. An entry only
 * counts when it IS the specifier. Anything this cannot read as a quoted entry (a multi-line array,
 * an interpolated value) yields nothing, so the caller reports "not registered" rather than proof.
 */
function preloadEntries(value: string): readonly string[] {
  const closing = value.lastIndexOf("]")
  const inner = value.startsWith("[") && closing !== -1 ? value.slice(1, closing) : value
  const entries: string[] = []
  for (const raw of inner.split(",")) {
    const entry = raw.trim()
    // A TOML string is quoted at both ends with the same quote; two characters is the shortest one.
    if (entry.length < 2) continue
    const quote = entry.charCodeAt(0)
    if (quote !== 34 && quote !== 39) continue
    if (entry.charCodeAt(entry.length - 1) !== quote) continue
    entries.push(entry.slice(1, -1))
  }
  return entries
}

/**
 * Read the runtime proof out of `bunfig.toml`.
 *
 * Line-oriented on purpose: this runs inside `nifra check`, which must not execute or import anything
 * from the project, and the shape being read is a literal array of strings under a known key. A full
 * TOML parse would buy nothing here and would turn an unrelated syntax error elsewhere in the file
 * into a failure to answer this question.
 */
export function readSingleCopyRegistration(cwd: string): SingleCopyRegistration {
  const config = join(resolve(cwd), "bunfig.toml")
  let text: string
  try {
    text = readFileSync(config, "utf8")
  } catch {
    return { run: false, test: false }
  }
  let section = ""
  let run = false
  let test = false
  for (const line of text.split(/\r?\n/)) {
    const match = PRELOAD_ASSIGNMENT.exec(line)
    if (match?.groups === undefined) continue
    const { section: heading, value } = match.groups
    if (heading !== undefined) {
      section = heading.trim()
      continue
    }
    if (value === undefined || !preloadEntries(value).includes(SINGLE_COPY_REGISTER_SPECIFIER))
      continue
    if (section === "test") test = true
    else if (section === "") run = true
  }
  return { run, test, config }
}

/** The repository a linked checkout resolves its own dependencies from: its nearest `.git` ancestor.
 * A path that lands inside a `node_modules` is a package-manager store copy rather than a checkout,
 * and everything above it belongs to whoever owns that store - clamp to the copy itself. */
const repoBoundary = (packageRoot: string): string => {
  if (packageRoot.split(sep).includes("node_modules")) return packageRoot
  let dir = packageRoot
  for (let depth = 0; depth < MAX_REPO_DEPTH; depth++) {
    if (existsSync(join(dir, ".git"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return packageRoot
}

/** Walk up from `start` for `node_modules/<name>/package.json`, stopping after `boundary`. */
const installedCopy = (
  start: string,
  name: string,
  boundary: string,
): { readonly root: string; readonly version: string } | undefined => {
  const parts = name.split("/")
  for (let dir = start; ; dir = dirname(dir)) {
    const packageRoot = join(dir, "node_modules", ...parts)
    const meta = readJsonSync(join(packageRoot, "package.json"))
    if (meta !== undefined) {
      return {
        root: realpathOrSelf(packageRoot),
        version: typeof meta.version === "string" ? meta.version : "unknown",
      }
    }
    if (dir === boundary) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
  }
}

/** Every `node_modules` from the app root up to (and including) its repository root. */
const nodeModulesDirs = (root: string): readonly string[] => {
  const boundary = repoBoundary(root)
  const dirs: string[] = []
  let dir = root
  for (let depth = 0; depth < MAX_ANCESTOR_DIRS; depth++) {
    const candidate = join(dir, "node_modules")
    if (existsSync(candidate)) dirs.push(candidate)
    if (dir === boundary) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirs
}

/**
 * Package directories that are symlinked OUT of this repository - the `link:` / `file:` / `npm link`
 * consumers whose own imports resolve somewhere this install does not own. Those are the only
 * importers that can introduce a second copy; a normally-installed dependency resolves inside the
 * tree that just installed it.
 */
const linkedPackageDirs = (root: string): readonly string[] => {
  const repo = realpathOrSelf(repoBoundary(root))
  const found = new Set<string>()
  let scanned = 0
  for (const nodeModules of nodeModulesDirs(root)) {
    let entries: readonly string[]
    try {
      entries = readdirSync(nodeModules)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (scanned++ >= MAX_SCANNED_ENTRIES) return [...found]
      if (entry === ".bin" || entry === ".cache") continue
      const path = join(nodeModules, entry)
      // A scope directory is not a package; its children are.
      const children = entry.startsWith("@")
        ? readdirSync(path, { withFileTypes: true }).map((child) => join(path, child.name))
        : [path]
      for (const candidate of children) {
        if (scanned++ >= MAX_SCANNED_ENTRIES) return [...found]
        let link: ReturnType<typeof lstatSync>
        try {
          link = lstatSync(candidate)
        } catch {
          continue
        }
        if (!link.isSymbolicLink()) continue
        const target = realpathOrSelf(candidate)
        if (inside(repo, target)) continue
        found.add(target)
      }
    }
  }
  return [...found]
}

/** Concrete package names a declaration covers, taken from what is actually installed for the app. */
const declaredNames = (root: string, declared: readonly string[]): readonly string[] => {
  const names = new Set<string>()
  for (const entry of declared) {
    if (!entry.endsWith("/*")) {
      names.add(entry)
      continue
    }
    const scope = entry.slice(0, -2)
    for (const nodeModules of nodeModulesDirs(root)) {
      const scopeDir = join(nodeModules, ...scope.split("/"))
      try {
        for (const child of readdirSync(scopeDir)) names.add(`${scope}/${child}`)
      } catch {
        // No such scope installed here - the pattern simply matches nothing in this tree.
      }
    }
  }
  return [...names].sort()
}

/**
 * Work out which foreign copies exist and which of them may be redirected.
 *
 * Pure discovery: it reads `package.json` files and symlink targets, never application source, and
 * never mutates anything. Both the plugin and `nifra check`'s verification are built on it, so the
 * enforcement and the report cannot drift apart.
 */
export function planSingleCopy(options: SingleCopyOptions = {}): SingleCopyPlan {
  const root = realpathOrSelf(resolve(options.cwd ?? process.cwd()))
  const declared = options.packages ?? readSingleCopyDeclaration(root) ?? []
  if (declared.length === 0) return { root, declared, redirects: [], skipped: [] }

  const names = declaredNames(root, declared)
  const redirects: SingleCopyRedirect[] = []
  const skipped: SingleCopySkip[] = []
  const rootBoundary = repoBoundary(root)

  for (const linked of linkedPackageDirs(root)) {
    const boundary = repoBoundary(linked)
    for (const name of names) {
      if (!matchesSingleCopyDeclaration(declared, name)) continue
      const theirs = installedCopy(linked, name, boundary)
      if (theirs === undefined) continue
      const ours = installedCopy(root, name, rootBoundary)
      if (ours === undefined || ours.root === theirs.root) continue
      if (ours.version !== theirs.version) {
        skipped.push({
          package: name,
          from: theirs.root,
          reason: "version-skew",
          detail: `${theirs.version} there, ${ours.version} here - redirecting would serve a version that copy did not ask for`,
        })
        continue
      }
      if (redirects.some((redirect) => redirect.from === theirs.root)) continue
      redirects.push({ package: name, from: theirs.root, to: ours.root, version: ours.version })
    }
  }
  redirects.sort((a, b) => a.from.localeCompare(b.from))
  skipped.sort((a, b) => a.from.localeCompare(b.from))
  return { root, declared, redirects, skipped }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The module a foreign file should become: the same relative file inside the winning copy.
 *
 * Mapping FILE to FILE rather than file to export subpath is what makes this safe on a package with a
 * rich exports map. Guessing that `dist/server.js` is the `./server` subpath is guesswork that fails
 * on the first package whose map is not one-to-one; the counterpart path is a fact, and the two trees
 * hold the same version, so the layout matches by construction. When it does not, the file loads
 * untouched.
 */
const counterpart = (redirect: SingleCopyRedirect, path: string): string | undefined => {
  const rel = relative(redirect.from, path)
  if (rel === "" || rel.startsWith(`..${sep}`)) return undefined
  const target = join(redirect.to, rel)
  try {
    return statSync(target).isFile() ? target : undefined
  } catch {
    return undefined
  }
}

/**
 * A re-export of the winning file, written so both module systems keep working.
 *
 * `export *` forwards the named bindings, including the ones Bun synthesizes for a CommonJS target,
 * and the explicit default covers `module.exports` (react is CommonJS, and its consumers `require` it
 * as often as they import it). Static imports keep the module SYNCHRONOUS, which matters more than it
 * looks: an `await import()` here would make the module async, and a CommonJS `require` of an async
 * module fails outright with `require() async module … is unsupported`.
 */
const reexport = (target: string): string => {
  const from = JSON.stringify(target)
  return (
    `export * from ${from};\n` +
    `import * as __singleCopy from ${from};\n` +
    `export default __singleCopy.default ?? __singleCopy;\n`
  )
}

/** A Bun plugin - `Bun.plugin(...)` for the runtime, or a `plugins:` entry for `Bun.build`. */
export interface SingleCopyPlugin extends BunPlugin {
  /** What it will do, computed once at construction. Exposed so a caller can report it. */
  readonly plan: SingleCopyPlan
}

/**
 * Pin every declared package to the app's copy.
 *
 * Two hooks, because the two phases resolve differently. `onResolve` is the direct statement of the
 * rule and it is what a BUNDLER honours - it sees every bare specifier. The runtime does not deliver
 * bare specifiers to it at all, so the `onLoad` arm intercepts the foreign file itself and hands back
 * a re-export of the counterpart in the winning copy. The importer gets the same function objects and
 * therefore the same module state, which is the entire requirement.
 */
export function singleCopyPlugin(options: SingleCopyOptions = {}): SingleCopyPlugin {
  const plan = planSingleCopy(options)
  const declared = plan.declared
  return {
    name: "nifra-single-copy",
    plan,
    setup(build) {
      if (declared.length > 0) {
        const exact = declared.filter((entry) => !entry.endsWith("/*")).map(escapeRegExp)
        const scopes = declared
          .filter((entry) => entry.endsWith("/*"))
          .map((entry) => `${escapeRegExp(entry.slice(0, -1))}[^/]+`)
        const alternatives = [...exact.map((name) => `${name}(?:/.*)?`), ...scopes]
        if (alternatives.length > 0) {
          const filter = new RegExp(`^(?:${alternatives.join("|")})$`)
          build.onResolve({ filter }, (args) => {
            try {
              return { path: Bun.resolveSync(args.path, plan.root) }
            } catch {
              // Not installed for the app, so there is nothing to dedupe TO. Forcing a resolution here
              // would turn a working import into a build failure.
              return undefined
            }
          })
        }
      }
      if (plan.redirects.length === 0) return

      const roots = plan.redirects.map((redirect) => escapeRegExp(redirect.from)).join("|")
      // Anchored at the foreign roots so the winning copy can never match itself. It must not: this
      // hook has to return contents for everything it matches, and re-emitting a CommonJS entry as an
      // ES module is how `Export named 'useEffect' not found` happens.
      const filter = new RegExp(`^(?:${roots})[/\\\\].*${REDIRECTABLE.source}`)
      build.onLoad({ filter }, (args) => {
        for (const redirect of plan.redirects) {
          const target = counterpart(redirect, args.path)
          if (target === undefined) continue
          return { contents: reexport(target), loader: "js" }
        }
        // A runtime `onLoad` must always return an object - returning nothing fails the load rather
        // than falling through to the default. Hand back the file as it was, at its own path, so its
        // relative imports keep resolving exactly as they would have.
        return { contents: readFileSync(args.path, "utf8"), loader: "js" }
      })
    },
  }
}

/** Set once the runtime plugin is installed, so a checker can tell "one copy" from "deduplicated". */
export const SINGLE_COPY_ACTIVE = Symbol.for("nifra.single-copy.active")

/**
 * Install the plugin into the Bun RUNTIME. Import `@nifrajs/core/single-copy/register` from a
 * `bunfig.toml` preload rather than calling this from application code: a resolver installed from
 * inside a module cannot affect the imports that module already resolved.
 */
export function registerSingleCopy(options: SingleCopyOptions = {}): SingleCopyPlan {
  const plugin = singleCopyPlugin(options)
  if (plugin.plan.declared.length > 0) Bun.plugin(plugin)
  ;(globalThis as Record<symbol, unknown>)[SINGLE_COPY_ACTIVE] = plugin.plan
  return plugin.plan
}
