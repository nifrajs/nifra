/**
 * The one place the CLI imports TypeScript from.
 *
 * The interpolated-SQL rule parses source with the TypeScript compiler, because the regex it replaced
 * could not tell `sql\`… ${id} …\`` (bound) from a plain template (injectable) without guessing at
 * string and comment boundaries. That is the right tool, but it is a ~25 MB dependency, and the CLI's
 * own typecheck step already treats `tsc` as something the PROJECT provides rather than something the
 * CLI ships. Making it a hard dependency would have contradicted that for every install.
 *
 * So it is an optional peer, resolved at the moment the rule runs. Every Nifra project has TypeScript
 * - the templates all ship a `typecheck` script - so this resolves in practice; the point is that an
 * install does not pay for it.
 */

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

/** The slice of the compiler the SQL scanner uses. Structural, so the peer stays optional. */
export type TypeScriptApi = typeof import("typescript")

/**
 * Is this module actually the compiler, rather than something else published under the same name?
 *
 * The `typescript` package name also carries small non-compiler entry points (a version stub, for
 * one), and a resolver that falls back to a global download cache can hand one of those back. They
 * import cleanly and then explode on first use - `undefined is not an object (evaluating
 * 'ts.ScriptKind.TSX')` deep inside a scan - which reads as a Nifra bug rather than as "the compiler
 * we loaded is not a compiler". Checking the two members every caller needs turns that into a
 * resolution miss, which the fallbacks below already know how to handle.
 */
function isCompiler(module: unknown): module is TypeScriptApi {
  if (typeof module !== "object" || module === null) return false
  const api = module as Partial<TypeScriptApi>
  return typeof api.createSourceFile === "function" && api.ScriptKind !== undefined
}

/** Unwrap the CJS default interop wrapper, so both `import * as ts` shapes look the same. */
function compilerOf(module: unknown): TypeScriptApi | undefined {
  if (isCompiler(module)) return module
  const wrapped = (module as { default?: unknown } | undefined)?.default
  return isCompiler(wrapped) ? wrapped : undefined
}

/**
 * Import TypeScript from the CLI's own dependency tree, or `undefined` when it is not installed.
 *
 * Only a RESOLUTION failure is absence. A compiler that resolves and then fails while evaluating is a
 * broken install, not a missing one, and telling that user to install what they already have sends
 * them the wrong way - so that error is rethrown for the caller to report.
 */
export async function importTypeScript(): Promise<TypeScriptApi | undefined> {
  try {
    return compilerOf(await import("typescript"))
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/cannot find (?:package|module)|ERR_MODULE_NOT_FOUND/i.test(message)) return undefined
    throw cause
  }
}

/**
 * Find the project's compiler the way module resolution would: `node_modules/typescript` in `root`,
 * then each parent directory up to the filesystem root - the same walk the typecheck gate uses to
 * find `tsc`, so both gates agree on which compiler the project has.
 *
 * The walk is deliberate, not a fallback for a missing resolver. `Bun.resolveSync` memoizes a
 * specifier for the life of the process AND auto-installs from the global download cache when the
 * project has none, so a long-lived process (the MCP server) that first resolved `typescript` before
 * `bun install` kept handing back that cache entry afterwards - the typecheck went phantom until the
 * server was restarted. A filesystem probe is re-answered every call, so an install that lands
 * mid-session is picked up on the next scan.
 */
function resolveProjectTypeScript(root: string): string | undefined {
  let dir = root
  while (true) {
    const pkg = join(dir, "node_modules", "typescript")
    // `lib/typescript.js` is the compiler entry across every published major; probing it directly
    // (rather than importing the directory) keeps a package whose main entry is a stub out of play.
    const entry = join(pkg, "lib", "typescript.js")
    if (existsSync(entry)) return entry
    if (existsSync(join(pkg, "package.json"))) return pkg
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Import TypeScript resolved from the PROJECT root first, falling back to the CLI's own dependency
 * tree. A bare `import("typescript")` resolves relative to this file - the CLI's install - so a
 * globally-installed or bunx-run CLI could miss the project's compiler (or load a different major)
 * depending on where the CLI happened to live, while the project's own `typescript` sat unused in
 * its node_modules. Resolving from `root` makes the verdicts a function of the project, not of how
 * the CLI was installed - the same cwd-invariance the typecheck gate's tsc resolution has.
 */
export async function importProjectTypeScript(root: string): Promise<TypeScriptApi | undefined> {
  const resolved = resolveProjectTypeScript(root)
  // Not installed in the project (or installed without a compiler entry): fall back to the CLI's own
  // tree, which keeps the previous behavior as the floor.
  if (resolved === undefined) return importTypeScript()
  try {
    const compiler = compilerOf(await import(resolved))
    return compiler ?? (await importTypeScript())
  } catch (cause) {
    // Same contract as importTypeScript: a compiler that RESOLVES and then fails evaluating is a
    // broken install, not a missing one - rethrow rather than silently checking with another copy.
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/cannot find (?:package|module)|ERR_MODULE_NOT_FOUND/i.test(message))
      return importTypeScript()
    throw cause
  }
}
