/**
 * Rewrites the one call the compiler's refresh pass emits into the dialect Bun's dev server speaks.
 * Dev-server client compiles only (`solidBunPlugin("dom")`).
 *
 * The pass ends every component module with
 *
 *     if (import.meta.hot) { import.meta.hot.accept(); _$$refresh("vite", import.meta.hot, _REGISTRY) }
 *
 * which is a Vite assumption: that `import.meta.hot` is an object you can pass around. Bun's bundler
 * instead rewrites `import.meta.hot.<prop>` where it can see it and substitutes, for every other use, a
 * proxy that throws `import.meta.hot.<prop> cannot be used indirectly` on the first property read. So the
 * argument has to become something built from member accesses Bun CAN see, and the rest of the
 * adaptation moves into `./refresh-hot` (which also supplies the cross-version store and the reload that
 * stands in for Bun's unimplemented `invalidate`):
 *
 *     if (import.meta.hot) { _ref(import.meta.url, (cb) => import.meta.hot.accept(cb), _REGISTRY) }
 *
 * A miss throws instead of passing the code through: an unrewritten call leaves a module that throws on
 * load, which is far harder to trace than this error.
 */

/**
 * The virtual specifier for `./refresh-hot`, resolved by `solidBunPlugin` against THIS package. The
 * import lands in an app's own file, where a relative path would be wrong and a bare `@nifrajs/web-solid`
 * subpath would depend on how the app's install happens to be laid out.
 */
export const SOLID_HOT_MODULE = "nifra:solid-hot"

const REFRESH_IMPORT = /import \{ \$\$refresh as ([\w$]+) \} from "solid-js\/refresh";?/
const REFRESH_CALL = /([\w$]+)\("vite", import\.meta\.hot, ([\w$]+)\);?/
const BARE_ACCEPT = /^[ \t]*import\.meta\.hot\.accept\(\);?[ \t]*\n/m

/** `code` with its refresh call rewritten for Bun. */
export function rewriteRefreshCall(code: string): string {
  const imported = REFRESH_IMPORT.exec(code)
  const call = REFRESH_CALL.exec(code)
  if (imported === null || call === null || call[1] !== imported[1])
    throw new Error("[nifra/web-solid] the refresh pass emitted a call this build cannot rewrite")
  const local = imported[1]
  return code
    .replace(REFRESH_IMPORT, `import { refresh as ${local} } from "${SOLID_HOT_MODULE}";`)
    .replace(BARE_ACCEPT, "")
    .replace(
      REFRESH_CALL,
      `${local}(import.meta.url, (cb) => import.meta.hot.accept(cb), ${call[2]});`,
    )
}
