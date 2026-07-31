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
