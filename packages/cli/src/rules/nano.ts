import type * as TSApi from "typescript"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { importProjectTypeScript } from "../internal/typescript-import.ts"
import type { CheckRule, SourceIndex } from "./index.ts"

/**
 * The nano lane lints (`@nifrajs/web/nano`). nano is deliberately explicit - every reactive edge is a
 * `bind`/`bindList` call or a `computed(fn, [deps])` - and that is exactly what makes its three
 * mistakes STATICALLY catchable, the property a framework's auto-tracked reactivity cannot offer:
 *
 *   NF-C021  a `bind`/`bindList`/`bindResource` whose disposer is discarded (leaks on teardown)
 *   NF-C022  a `bindList` keyed by the array index (breaks add/remove/reorder)
 *   NF-C023  a `computed`/`resource` `(fn, [deps])` reading a signal its `deps` omit (won't recompute/refetch)
 *
 * All three warn (never block): a false positive must never fail a build, and each maps to a fix
 * recipe (`nano.*`). Deliberately conservative - only the unambiguous authoring shapes are inspected.
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

type Fn = TSApi.ArrowFunction | TSApi.FunctionExpression
const isFn = (ts: typeof TSApi, n: TSApi.Node): n is Fn =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n)

/** Names bound to a `signal(...)` or `computed(...)` result anywhere in the file - the reactive cells
 * a `computed` body may read and must therefore declare. */
function reactiveBindings(ts: typeof TSApi, tree: TSApi.SourceFile): Set<string> {
  const names = new Set<string>()
  const visit = (n: TSApi.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer !== undefined &&
      ts.isCallExpression(n.initializer) &&
      ts.isIdentifier(n.initializer.expression) &&
      (n.initializer.expression.text === "signal" ||
        n.initializer.expression.text === "computed" ||
        n.initializer.expression.text === "resource")
    ) {
      names.add(n.name.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(tree)
  return names
}

/** Reactive identifiers read as `x.get()` inside `fn`. */
function getsInside(ts: typeof TSApi, fn: TSApi.Node, reactive: ReadonlySet<string>): Set<string> {
  const reads = new Set<string>()
  const visit = (n: TSApi.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "get" &&
      ts.isIdentifier(n.expression.expression) &&
      reactive.has(n.expression.expression.text)
    ) {
      reads.add(n.expression.expression.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(fn)
  return reads
}

/** The identifiers listed in a `computed`'s deps array literal (non-identifier entries are ignored -
 * an unusual deps shape simply isn't linted rather than mis-flagged). */
function declaredDeps(ts: typeof TSApi, depsArg: TSApi.Expression): Set<string> {
  const deps = new Set<string>()
  if (ts.isArrayLiteralExpression(depsArg)) {
    for (const el of depsArg.elements) if (ts.isIdentifier(el)) deps.add(el.text)
  }
  return deps
}

/** A `bind`/`bindList` call whose return value is discarded: its immediate parent is the expression
 * statement itself (not an assignment, array element, `return`, `await`, or argument). */
function isDiscarded(ts: typeof TSApi, call: TSApi.CallExpression): boolean {
  const parent = call.parent
  return parent !== undefined && ts.isExpressionStatement(parent)
}

/** For a `bindList(src, container, { key, ... })`, the `key` property's function if it is an inline
 * arrow/function literal. */
function keyFn(ts: typeof TSApi, call: TSApi.CallExpression): Fn | undefined {
  const opts = call.arguments[2]
  if (opts === undefined || !ts.isObjectLiteralExpression(opts)) return undefined
  for (const prop of opts.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === "key" &&
      isFn(ts, prop.initializer)
    ) {
      return prop.initializer
    }
  }
  return undefined
}

/** Does `fn`'s body return its own second parameter (the index) directly? `key: (_, i) => i`, the
 * classic reorder-breaking key. Conservative: only a bare `return <secondParam>` / concise `=> i`. */
function returnsSecondParam(ts: typeof TSApi, fn: Fn): boolean {
  if (fn.parameters.length < 2) return false
  const second = fn.parameters[1]
  if (second === undefined || !ts.isIdentifier(second.name)) return false
  const idx = second.name.text
  const isIdxRef = (e: TSApi.Expression): boolean => ts.isIdentifier(e) && e.text === idx
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return isIdxRef(fn.body)
  let found = false
  const visit = (n: TSApi.Node): void => {
    if (found) return
    if (isFn(ts, n) || ts.isFunctionDeclaration(n)) return // not a nested fn's return
    if (ts.isReturnStatement(n) && n.expression !== undefined && isIdxRef(n.expression)) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(fn, visit)
  return found
}

const lineOf = (tree: TSApi.SourceFile, n: TSApi.Node): number =>
  tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1

function toolchainMissing(code: string): Diagnostic {
  return diagnostic({
    code,
    severity: "warn",
    message: `nano lint (${code}) did NOT run - TypeScript is not installed, so this report says nothing about it`,
    fix: { recipe: "toolchain.install-typescript", command: "bun add -d typescript" },
    verify: "nifra check --lints-only",
  })
}

export const nanoBindCleanupRule: CheckRule = {
  code: "NF-C021",
  title: "nano binding cleanup check",
  async scan(ctx) {
    const ts = await importProjectTypeScript(ctx.root)
    if (ts === undefined) return [toolchainMissing("NF-C021")]
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      const tree = parsedTree(ts, ctx.project.source, file)
      if (tree === undefined) continue
      const visit = (n: TSApi.Node): void => {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          (n.expression.text === "bind" ||
            n.expression.text === "bindList" ||
            n.expression.text === "bindResource") &&
          isDiscarded(ts, n)
        ) {
          findings.push(
            diagnostic({
              code: "NF-C021",
              severity: "warn",
              file,
              line: lineOf(tree, n),
              message: `${n.expression.text}(...) discards its cleanup - collect the returned disposer and call it on teardown, or it leaks on soft-nav`,
              evidence: [`${n.expression.text}(...) as a bare statement`],
              fix: { recipe: "nano.collect-cleanup", command: "nifra_docs nano" },
              verify: "nifra check --lints-only",
            }),
          )
        }
        ts.forEachChild(n, visit)
      }
      visit(tree)
    }
    return findings
  },
}

export const nanoListKeyRule: CheckRule = {
  code: "NF-C022",
  title: "nano bindList key check",
  async scan(ctx) {
    const ts = await importProjectTypeScript(ctx.root)
    if (ts === undefined) return [toolchainMissing("NF-C022")]
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      const tree = parsedTree(ts, ctx.project.source, file)
      if (tree === undefined) continue
      const visit = (n: TSApi.Node): void => {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === "bindList"
        ) {
          const key = keyFn(ts, n)
          if (key !== undefined && returnsSecondParam(ts, key)) {
            findings.push(
              diagnostic({
                code: "NF-C022",
                severity: "warn",
                file,
                line: lineOf(tree, key),
                message:
                  "bindList key is the array index - add/remove/reorder will reuse the wrong node. Key by a stable id on the item instead",
                evidence: ["key: (_, i) => i"],
                fix: { recipe: "nano.stable-key", command: "nifra_docs nano" },
                verify: "nifra check --lints-only",
              }),
            )
          }
        }
        ts.forEachChild(n, visit)
      }
      visit(tree)
    }
    return findings
  },
}

export const nanoComputedDepsRule: CheckRule = {
  code: "NF-C023",
  title: "nano computed deps check",
  async scan(ctx) {
    const ts = await importProjectTypeScript(ctx.root)
    if (ts === undefined) return [toolchainMissing("NF-C023")]
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      const tree = parsedTree(ts, ctx.project.source, file)
      if (tree === undefined) continue
      const reactive = reactiveBindings(ts, tree)
      if (reactive.size === 0) continue
      const visit = (n: TSApi.Node): void => {
        const fnArg = ts.isCallExpression(n) ? n.arguments[0] : undefined
        const depsArg = ts.isCallExpression(n) ? n.arguments[1] : undefined
        const callName =
          ts.isCallExpression(n) && ts.isIdentifier(n.expression) ? n.expression.text : undefined
        if (
          (callName === "computed" || callName === "resource") &&
          fnArg !== undefined &&
          depsArg !== undefined &&
          isFn(ts, fnArg)
        ) {
          const reads = getsInside(ts, fnArg, reactive)
          const deps = declaredDeps(ts, depsArg)
          const missing = [...reads].filter((r) => !deps.has(r))
          if (missing.length > 0) {
            const verb = callName === "resource" ? "refetch" : "recompute"
            findings.push(
              diagnostic({
                code: "NF-C023",
                severity: "warn",
                file,
                line: lineOf(tree, n),
                message: `${callName} reads ${JSON.stringify([...reads])} but its deps declare ${JSON.stringify([...deps])} - it will not ${verb} when ${missing.join(", ")} changes. Add ${missing.join(", ")} to the deps array`,
                evidence: [`missing dep: ${missing.join(", ")}`],
                fix: { recipe: "nano.declare-deps", command: "nifra_docs nano" },
                verify: "nifra check --lints-only",
              }),
            )
          }
        }
        ts.forEachChild(n, visit)
      }
      visit(tree)
    }
    return findings
  },
}

export const nanoRules = Object.freeze([nanoBindCleanupRule, nanoListKeyRule, nanoComputedDepsRule])
