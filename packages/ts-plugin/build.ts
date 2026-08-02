/**
 * Build @nifrajs/ts-plugin.
 *
 * A TypeScript language-service plugin is loaded by tsserver with `require()`, and tsserver expects the
 * required value to BE the factory function - it does not unwrap an ESM default export. So the Node/dist
 * entry is emitted as CommonJS whose `module.exports` IS `init`; an ESM `export default init` would hand
 * tsserver a namespace object and be rejected ("did not expose a proper factory function"). The package
 * stays `type: module` and Bun keeps using the ESM source via the `"bun"` export condition - only the
 * `default` (Node) entry is CommonJS.
 *
 * `src/index.ts` is bundled to that CommonJS entry with the framework packages left external (resolved
 * from the consumer's node_modules at load time); tsc supplies the declarations and the ESM `./resolve`
 * helper. Nothing here vendors nifra into the plugin.
 *
 *   bun run build.ts
 */
import { readdir, rm } from "node:fs/promises"

const dir = import.meta.dir
const dist = `${dir}/dist`
// Import specifiers to leave as runtime `require(...)` rather than inline into the bundle.
const external = ["typescript", "@nifrajs/core", "@nifrajs/core/pattern", "@nifrajs/web", "@nifrajs/web/fs"]

await rm(dist, { recursive: true, force: true })

// 1) Emit `.js` + `.d.ts` with tsc. `bun run <file>` leaves node_modules/.bin off PATH, so resolve the
//    compiler entry explicitly. `--incremental false` is required: the repo shares one root `.tsbuildinfo`
//    (tsconfig.base), so an incremental run would skip emit here since `rm dist` doesn't clear that cache.
const tscEntry = Bun.fileURLToPath(import.meta.resolve("typescript")).replace(/typescript\.js$/, "tsc.js")
const tsc = Bun.spawn(["node", tscEntry, "-p", "tsconfig.build.json", "--incremental", "false"], {
  cwd: dir,
  stdout: "inherit",
  stderr: "inherit",
})
if ((await tsc.exited) !== 0) throw new Error("ts-plugin: tsc failed")

// 2) Rewrite the `.ts`->`.js` relative specifiers TS 5.9 leaves in emitted `.d.ts` (same pass as
//    scripts/fix-dts.ts, inlined). Relative `from "./x.ts"` / `import("./x.ts")` only.
const relativeTs = /((?:from|import\()\s*["'])(\.\.?\/[^"']*?)\.ts(["'])/g
for (const file of await readdir(dist, { recursive: true })) {
  if (!file.endsWith(".d.ts")) continue
  const path = `${dist}/${file}`
  const source = await Bun.file(path).text()
  const rewritten = source.replace(relativeTs, "$1$2.js$3")
  if (rewritten !== source) await Bun.write(path, rewritten)
}

// 3) Replace tsc's ESM `index.js` with a CommonJS factory: bundle `src/index.ts` to CJS, then force
//    `module.exports === init` regardless of how the bundler shaped the default export (bare function, or
//    a `{ default }` interop namespace). tsc's `resolve.js`/`.d.ts` (the ESM `./resolve` helper) stay.
const entry = await Bun.build({
  entrypoints: [`${dir}/src/index.ts`],
  target: "node",
  format: "cjs",
  external,
})
if (!entry.success) throw new AggregateError(entry.logs, "ts-plugin: index bundle failed")
const [entryOut] = entry.outputs
if (entryOut === undefined) throw new Error("ts-plugin: index bundle produced no output")
const factoryFooter =
  "\nmodule.exports = module.exports && module.exports.default ? module.exports.default : module.exports\n"
await Bun.write(`${dist}/index.cjs`, (await entryOut.text()) + factoryFooter)
await rm(`${dist}/index.js`, { force: true })
await rm(`${dist}/index.js.map`, { force: true })

console.log("ts-plugin: built dist/index.cjs (CommonJS factory) + dist/resolve.js + declarations")
