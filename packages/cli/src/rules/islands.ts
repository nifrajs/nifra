import type * as TSApi from "typescript"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { importProjectTypeScript } from "../internal/typescript-import.ts"
import type { CheckRule, SourceIndex } from "./index.ts"

/**
 * NF-C020 - the island cleanup lint. An island enhancer (`@nifrajs/web/islands`) runs once and must
 * hand back a teardown for anything it wires: `mountIslands`'s disposer calls it on soft-nav, and
 * without it every navigation leaks the listener. This is the single mistake an agent writing
 * imperative island code makes most - it adds `el.addEventListener(...)` and forgets the `return`.
 * The lint watches the two authoring shapes and warns (never blocks) when a block-body enhancer adds
 * a listener but returns no cleanup:
 *
 *   defineIsland((el) => { el.addEventListener("click", f) })          // ← flagged: no cleanup
 *   defineIsland((el) => { el.addEventListener("click", f); return () => el.removeEventListener("click", f) })  // ok
 *   mountIslands({ x: (el) => { el.addEventListener("click", f) } })   // ← flagged
 *
 * Deliberately conservative to stay false-positive-free: a concise-body arrow (`(el) => bus.on(...)`)
 * already IS a returned value, so it is never flagged; a block that returns anything is trusted as
 * cleanup; only an inline function literal is inspected (a `defineIsland(...)` result referenced by
 * name is caught at its definition site, never twice).
 */

const parseCache = new WeakMap<
  SourceIndex,
  Map<string, { readonly tree: TSApi.SourceFile } | null>
>()

function parsedTree(
  ts: typeof TSApi,
  sources: SourceIndex,
  file: string,
): TSApi.SourceFile | undefined {
  let files = parseCache.get(sources)
  if (files === undefined) {
    files = new Map()
    parseCache.set(sources, files)
  }
  const cached = files.get(file)
  if (cached !== undefined) return cached?.tree
  const source = sources.read(file)
  if (source === undefined) {
    files.set(file, null)
    return undefined
  }
  const kind = /\.tsx?$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.JS
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  files.set(file, { tree })
  return tree
}

type EnhancerFn = TSApi.ArrowFunction | TSApi.FunctionExpression

function isEnhancerFn(ts: typeof TSApi, node: TSApi.Node): node is EnhancerFn {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node)
}

/** Any `<expr>.addEventListener(...)` reachable inside the enhancer (nested handlers included - the
 * presence of the wiring is what matters, not its depth). */
function addsListener(ts: typeof TSApi, fn: EnhancerFn): boolean {
  let found = false
  const walk = (node: TSApi.Node): void => {
    if (found) return
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "addEventListener"
    ) {
      found = true
      return
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(fn, walk)
  return found
}

/** Does the enhancer hand back a value? A concise-body arrow always does. A block body counts only a
 * `return <expr>` that is NOT inside a nested function (a nested handler's return is not the
 * enhancer's cleanup). */
function returnsCleanup(ts: typeof TSApi, fn: EnhancerFn): boolean {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return true // concise body IS the return value
  let found = false
  const walk = (node: TSApi.Node): void => {
    if (found) return
    if (isEnhancerFn(ts, node) || ts.isFunctionDeclaration(node)) return // don't descend into nested fns
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      found = true
      return
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(fn, walk)
  return found
}

/** The inline enhancer functions authored in `file`: the argument to `defineIsland(...)` and every
 * function-typed value of a `mountIslands({ ... })` object literal. */
function enhancerFns(ts: typeof TSApi, tree: TSApi.SourceFile): EnhancerFn[] {
  const out: EnhancerFn[] = []
  const visit = (node: TSApi.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text
      if (callee === "defineIsland") {
        const arg = node.arguments[0]
        if (arg !== undefined && isEnhancerFn(ts, arg)) out.push(arg)
      } else if (callee === "mountIslands") {
        const arg = node.arguments[0]
        if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            // Only inline function literals `{ x: (el) => {…} }` are inspected. A shorthand method
            // `{ x(el) {…} }` or a named reference `{ x: counter }` is left to its definition site.
            if (ts.isPropertyAssignment(prop) && isEnhancerFn(ts, prop.initializer))
              out.push(prop.initializer)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return out
}

export const islandCleanupRule: CheckRule = {
  code: "NF-C020",
  title: "Island enhancer cleanup check",
  async scan(ctx) {
    const ts = await importProjectTypeScript(ctx.root)
    if (ts === undefined) {
      return [
        diagnostic({
          code: "NF-C020",
          severity: "warn",
          message:
            "Island enhancer cleanup check (NF-C020) did NOT run - TypeScript is not installed, so this report says nothing about it",
          fix: { recipe: "toolchain.install-typescript", command: "bun add -d typescript" },
          verify: "nifra check --lints-only",
        }),
      ]
    }
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      const tree = parsedTree(ts, ctx.project.source, file)
      if (tree === undefined) continue
      for (const fn of enhancerFns(ts, tree)) {
        if (!addsListener(ts, fn) || returnsCleanup(ts, fn)) continue
        const line = tree.getLineAndCharacterOfPosition(fn.getStart(tree)).line + 1
        findings.push(
          diagnostic({
            code: "NF-C020",
            severity: "warn",
            file,
            line,
            message:
              "island enhancer adds an event listener but returns no cleanup - it leaks on soft-nav teardown",
            evidence: ["addEventListener without a returned cleanup"],
            fix: {
              recipe: "islands.return-cleanup",
              command: "nifra_docs islands",
            },
            verify: "nifra check --lints-only",
          }),
        )
      }
    }
    return findings
  },
}

export const islandRules = Object.freeze([islandCleanupRule])
