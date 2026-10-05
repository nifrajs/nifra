/**
 * Side-effect entry (`@nifrajs/core/single-copy/register`): install the single-copy resolver into the
 * Bun runtime.
 *
 * Preload it - never import it from application code:
 *
 * ```toml
 * # bunfig.toml
 * preload = ["@nifrajs/core/single-copy/register"]
 * [test]
 * preload = ["@nifrajs/core/single-copy/register"]
 * ```
 *
 * A resolver only affects imports that have not resolved yet, and a module's own imports resolve
 * before its body runs. Registering from inside application code would therefore miss exactly the
 * imports it exists to redirect. `preload` runs before the entry point, which is the only moment that
 * covers the whole graph.
 *
 * `nifra check` reads this specifier out of `bunfig.toml` as the proof that the runtime arm is armed,
 * so the string above is a contract rather than a suggestion.
 *
 * A declared package that cannot be collapsed (two versions, or a file with no counterpart in the
 * app's copy) prints one warning per package naming both copies. Set
 * `"singleCopy": { "packages": [...], "strict": true }` in package.json, or `NIFRA_SINGLE_COPY_STRICT=1`,
 * to make the preload throw instead.
 */
import { registerSingleCopy } from "./single-copy"

registerSingleCopy()
