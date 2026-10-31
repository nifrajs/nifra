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
 * covers the whole graph. When Bun starts a filtered workspace script below the app root, the
 * registrar finds the nearest ancestor package declaring `nifra.singleCopy` and passes that root to
 * the resolver instead of planning against the workspace package's manifest.
 *
 * `nifra check` recognizes this public specifier and verifies checkout-local relative preloads before
 * treating them as proof that the runtime arm is armed.
 *
 * A declared package that cannot be collapsed (two versions, or a file with no counterpart in the
 * app's copy) prints one warning per package naming both copies. Set
 * `"singleCopy": { "packages": [...], "strict": true }` in package.json, or `NIFRA_SINGLE_COPY_STRICT=1`,
 * to make the preload throw instead.
 */
import { registerSingleCopy } from "./single-copy"

registerSingleCopy()
