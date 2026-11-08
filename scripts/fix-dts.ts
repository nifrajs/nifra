/**
 * Rewrite relative `.ts` import/export specifiers to `.js` in emitted `.d.ts` files.
 *
 * `tsc`'s `rewriteRelativeImportExtensions` rewrites the `.js` output correctly but
 * (as of TS 5.9) leaves declaration specifiers as `.ts`, which breaks consumers that
 * don't enable `allowImportingTsExtensions`. This pass closes that gap.
 *
 * It also adds `/// <reference lib="esnext.disposable" />` to a declaration that names
 * `Symbol.dispose` / `Symbol.asyncDispose`: `tsc` drops that directive from its own output when the
 * project's `lib` already has it, and a consumer on `lib: ["ES2022"]` without `skipLibCheck` would
 * otherwise fail on the declaration.
 *
 *   bun run scripts/fix-dts.ts <dir>   # dir defaults to "dist"
 */
import { Glob } from "bun"

const dir = process.argv[2] ?? "dist"
// `from "./x.ts"` / `from '../y.ts'` and `import("./x.ts")` - relative specifiers only.
const RELATIVE_TS = /((?:from|import\()\s*["'])(\.\.?\/[^"']*?)\.ts(["'])/g

const DISPOSABLE_LIB = '/// <reference lib="esnext.disposable" />\n'
const NAMES_DISPOSE = /\bSymbol\.(?:async)?[Dd]ispose\b/

let changed = 0
for await (const file of new Glob("**/*.d.ts").scan(dir)) {
  const path = `${dir}/${file}`
  const source = await Bun.file(path).text()
  let rewritten = source.replace(RELATIVE_TS, "$1$2.js$3")
  if (NAMES_DISPOSE.test(rewritten) && !rewritten.includes(DISPOSABLE_LIB))
    rewritten = DISPOSABLE_LIB + rewritten
  if (rewritten !== source) {
    await Bun.write(path, rewritten)
    changed += 1
  }
}
console.log(`fix-dts: fixed ${changed} .d.ts file(s) under ${dir}/`)
