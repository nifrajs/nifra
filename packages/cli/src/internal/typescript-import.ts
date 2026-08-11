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

/** The slice of the compiler the SQL scanner uses. Structural, so the peer stays optional. */
export type TypeScriptApi = typeof import("typescript")

/**
 * Import the project's TypeScript, or `undefined` when it is not installed.
 *
 * Only a RESOLUTION failure is absence. A compiler that resolves and then fails while evaluating is a
 * broken install, not a missing one, and telling that user to install what they already have sends
 * them the wrong way - so that error is rethrown for the caller to report.
 */
export async function importTypeScript(): Promise<TypeScriptApi | undefined> {
  try {
    return (await import("typescript")) as TypeScriptApi
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/cannot find (?:package|module)|ERR_MODULE_NOT_FOUND/i.test(message)) return undefined
    throw cause
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
  let resolved: string
  try {
    resolved = Bun.resolveSync("typescript", root)
  } catch {
    // Unresolvable from the project (not installed there, or a non-Bun host without resolveSync):
    // fall back to the CLI's own tree, which keeps the previous behavior as the floor.
    return importTypeScript()
  }
  try {
    return (await import(resolved)) as TypeScriptApi
  } catch (cause) {
    // Same contract as importTypeScript: a compiler that RESOLVES and then fails evaluating is a
    // broken install, not a missing one - rethrow rather than silently checking with another copy.
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/cannot find (?:package|module)|ERR_MODULE_NOT_FOUND/i.test(message))
      return importTypeScript()
    throw cause
  }
}
