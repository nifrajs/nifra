/**
 * A Babel pass that runs AFTER `solid-refresh` and rewrites the one call it emits into the dialect
 * Bun's dev server speaks. Dev-server client compiles only (`solidBunPlugin("dom")`).
 *
 * `solid-refresh` ends every component module with
 *
 *     if (import.meta.hot) { _$$refresh("esm", import.meta.hot, _REGISTRY) }
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
 * Rewriting rather than string-replacing matters: the identifier `solid-refresh` picks is uniquified
 * against the module's own scope, so it is not a fixed string, and a silent miss would leave a module
 * that throws on load.
 */
import type { BabelFile, types as BabelTypes, NodePath, PluginObj, PluginPass } from "@babel/core"

/**
 * The virtual specifier for `./refresh-hot`, resolved by `solidBunPlugin` against THIS package. The
 * import lands in an app's own file, where a relative path would be wrong and a bare `@nifrajs/web-solid`
 * subpath would depend on how the app's install happens to be laid out.
 */
export const SOLID_HOT_MODULE = "nifra:solid-hot"

/** `solid-refresh`'s call, under whatever uid Babel gave the import in this module's scope. */
const REFRESH_CALLEE = /^_*\$\$refresh\d*$/

/** Per-file memo of the injected `refresh` import, so a module with many components imports it once. */
const injected = new WeakMap<PluginPass, BabelTypes.Identifier>()

/**
 * `import.meta`, in either of the two shapes it can arrive in: the `MetaProperty` a parser produces, and
 * the plain `import` . `meta` member expression `solid-refresh` hand-builds. Matching only the former is
 * what a first cut gets wrong - the emitted call reads `import.meta.hot` but is not a `MetaProperty`.
 */
const isImportMeta = (t: typeof BabelTypes, node: BabelTypes.Node): boolean =>
  (t.isMetaProperty(node) && node.meta.name === "import" && node.property.name === "meta") ||
  (t.isMemberExpression(node) &&
    !node.computed &&
    t.isIdentifier(node.object, { name: "import" }) &&
    t.isIdentifier(node.property, { name: "meta" }))

/** `import.meta.hot` exactly - the argument this pass replaces. */
const isImportMetaHot = (t: typeof BabelTypes, node: BabelTypes.Node): boolean =>
  t.isMemberExpression(node) &&
  !node.computed &&
  isImportMeta(t, node.object) &&
  t.isIdentifier(node.property) &&
  node.property.name === "hot"

const importMetaMember = (t: typeof BabelTypes, property: string): BabelTypes.MemberExpression =>
  t.memberExpression(
    t.metaProperty(t.identifier("import"), t.identifier("meta")),
    t.identifier(property),
  )

/** `(cb) => import.meta.hot.accept(cb)` - `accept` reached the only way Bun's bundler recognizes. */
function acceptClosure(t: typeof BabelTypes): BabelTypes.ArrowFunctionExpression {
  const callback = t.identifier("cb")
  return t.arrowFunctionExpression(
    [callback],
    t.callExpression(t.memberExpression(importMetaMember(t, "hot"), t.identifier("accept")), [
      callback,
    ]),
  )
}

function refreshImport(
  t: typeof BabelTypes,
  path: NodePath<BabelTypes.CallExpression>,
  state: PluginPass,
): BabelTypes.Identifier {
  const existing = injected.get(state)
  if (existing !== undefined) return existing
  const program = path.scope.getProgramParent().path as NodePath<BabelTypes.Program>
  const local = program.scope.generateUidIdentifier("nifraSolidRefresh")
  program.node.body.unshift(
    t.importDeclaration(
      [t.importSpecifier(local, t.identifier("refresh"))],
      t.stringLiteral(SOLID_HOT_MODULE),
    ),
  )
  injected.set(state, local)
  return local
}

export default function solidRefreshBunHot({
  types: t,
}: {
  types: typeof BabelTypes
}): PluginObj<PluginPass> {
  return {
    name: "nifra-solid-refresh-bun-hot",
    // Required by the plugin shape, and deliberately empty - see `post` below.
    visitor: {},
    // No visitor entries at all: the call this pass rewrites does not exist during the shared traversal.
    // `solid-refresh` appends it with `pushContainer` from its own `Program` handler, and nodes added
    // that way are never handed to the other plugins' visitors. `Program.exit` is no better - exit
    // handlers fire in plugin order, so this one would run BEFORE the append. `post` runs once the
    // file's whole traversal is finished, which is the first point at which the call is there to see.
    post(this: PluginPass, file: BabelFile) {
      const state = this
      file.path.traverse({
        CallExpression(path) {
          const callee = path.node.callee
          if (!t.isIdentifier(callee) || !REFRESH_CALLEE.test(callee.name)) return
          const args = path.node.arguments
          // ("esm", import.meta.hot, registry) - anything else is not the call this pass is for.
          if (args.length !== 3) return
          const hot = args[1]
          const registry = args[2]
          if (hot === undefined || registry === undefined || !isImportMetaHot(t, hot)) return
          if (!t.isExpression(registry)) return
          // The replacement's callee is the injected uid, which REFRESH_CALLEE never matches, so the
          // re-traversal `replaceWith` triggers terminates here.
          path.replaceWith(
            t.callExpression(refreshImport(t, path, state), [
              importMetaMember(t, "url"),
              acceptClosure(t),
              registry,
            ]),
          )
        },
      })
    },
  }
}
