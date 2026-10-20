import type * as TSApi from "typescript"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { scriptKindOf } from "../internal/script-kind.ts"
import type { CheckRule, SourceIndex } from "./index.ts"
import { loadRuleTypeScript } from "./typescript.ts"

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
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(ts, file),
  )
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
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    const ts = loaded.compiler
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

const lineOf = (tree: TSApi.SourceFile, node: TSApi.Node): number =>
  tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1

function toolchainMissing(code: string, title: string): Diagnostic {
  return diagnostic({
    code,
    severity: "warn",
    message: `${title} (${code}) did NOT run - TypeScript is not installed, so this report says nothing about it`,
    fix: { recipe: "toolchain.install-typescript", command: "bun add -d typescript" },
    verify: "nifra check --lints-only",
  })
}

/** The names a parameter binds: its identifier, or each identifier its destructuring pattern binds. */
function boundNames(
  ts: typeof TSApi,
  name: TSApi.BindingName,
  out = new Set<string>(),
): Set<string> {
  if (ts.isIdentifier(name)) out.add(name.text)
  else
    for (const element of name.elements)
      if (!ts.isOmittedExpression(element)) boundNames(ts, element.name, out)
  return out
}

/** Whether `node` reads any of `names` (a property name such as the `id` of `x.id` is not a read). */
function readsAny(ts: typeof TSApi, node: TSApi.Node, names: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(node)) return names.has(node.text)
  if (ts.isPropertyAccessExpression(node)) return readsAny(ts, node.expression, names)
  return ts.forEachChild(node, (child) => readsAny(ts, child, names) || undefined) ?? false
}

const POSITION_CALLS = new Set(["indexOf", "lastIndexOf", "findIndex", "findLastIndex"])

/** A `bindList` key that reads a position: a second parameter it reads (`bindList` passes none, so
 * it is always `undefined`) or an `indexOf`-family call handed the item, which shifts on every insert
 * and removal. An `indexOf` over the item's own data, such as `u.email.indexOf("@")`, is not one. */
function positionalKey(ts: typeof TSApi, call: TSApi.CallExpression): EnhancerFn | undefined {
  const options = call.arguments[2]
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return undefined
  for (const prop of options.properties) {
    if (
      !ts.isPropertyAssignment(prop) ||
      !ts.isIdentifier(prop.name) ||
      prop.name.text !== "key" ||
      !isEnhancerFn(ts, prop.initializer)
    )
      continue
    const key = prop.initializer
    const [item, position] = key.parameters
    if (position !== undefined && readsAny(ts, key.body, boundNames(ts, position.name))) return key
    // A destructured second parameter throws on the `undefined` bindList passes.
    if (position !== undefined && !ts.isIdentifier(position.name)) return key
    if (item === undefined) continue
    const itemNames = boundNames(ts, item.name)
    const handedTheItem = (node: TSApi.Node): true | undefined =>
      (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        POSITION_CALLS.has(node.expression.name.text) &&
        node.arguments.some((arg) => readsAny(ts, arg, itemNames))) ||
      ts.forEachChild(node, handedTheItem)
    if (ts.forEachChild(key, handedTheItem)) return key
  }
  return undefined
}

export const islandListKeyRule: CheckRule = {
  code: "NF-C022",
  title: "bindList key check",
  async scan(ctx) {
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    const ts = loaded.compiler
    if (ts === undefined) return [toolchainMissing("NF-C022", "bindList key check")]
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      const tree = parsedTree(ts, ctx.project.source, file)
      if (tree === undefined) continue
      const visit = (node: TSApi.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "bindList"
        ) {
          const key = positionalKey(ts, node)
          if (key !== undefined) {
            findings.push(
              diagnostic({
                code: "NF-C022",
                severity: "warn",
                file,
                line: lineOf(tree, key),
                message:
                  "bindList key reads the item's position - an insert, removal or reorder hands a node to the wrong item. Key by a stable id on the item instead",
                evidence: ["key: (item, i) => i  or  key: (item) => list.indexOf(item)"],
                fix: { recipe: "islands.stable-key", command: "nifra_docs islands" },
                verify: "nifra check --lints-only",
              }),
            )
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(tree)
    }
    return findings
  },
}

/** What markup may name inside one island: `undefined` when the setup is not fully literal, so a name
 * cannot be judged and nothing is reported. */
type IslandNames =
  | {
      readonly kind: "bind"
      readonly state: ReadonlySet<string> | undefined
      readonly handlers: ReadonlySet<string> | undefined
    }
  | { readonly kind: "imperative" }

const UNKNOWN = Symbol("unknown")

function literalKeys(
  ts: typeof TSApi,
  node: TSApi.ObjectLiteralExpression,
): Set<string> | undefined {
  const keys = new Set<string>()
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop) || prop.name === undefined) return undefined
    if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) keys.add(prop.name.text)
    else return undefined
  }
  return keys
}

/** The state keys and handler names of a `bindIsland(setup)` whose setup is an inline function. */
function bindIslandNames(
  ts: typeof TSApi,
  setup: TSApi.Expression | undefined,
): IslandNames | typeof UNKNOWN {
  if (setup === undefined || !isEnhancerFn(ts, setup)) return UNKNOWN
  const param = setup.parameters[0]
  let stateName: string | undefined
  let ctxName: string | undefined
  if (param !== undefined) {
    if (ts.isIdentifier(param.name)) ctxName = param.name.text
    else if (ts.isObjectBindingPattern(param.name)) {
      for (const element of param.name.elements) {
        const prop = element.propertyName ?? element.name
        if (ts.isIdentifier(prop) && prop.text === "state" && ts.isIdentifier(element.name))
          stateName = element.name.text
        else if (element.dotDotDotToken !== undefined && ts.isIdentifier(element.name))
          ctxName = element.name.text
      }
    } else return UNKNOWN
  }
  let state: Set<string> | undefined = new Set()
  const walk = (node: TSApi.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isState =
        (stateName !== undefined && ts.isIdentifier(callee) && callee.text === stateName) ||
        (ctxName !== undefined &&
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === ctxName &&
          callee.name.text === "state")
      if (isState) {
        const key = node.arguments[0]
        if (key !== undefined && ts.isStringLiteralLike(key)) state?.add(key.text)
        else state = undefined
      }
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(setup.body, walk)
  const returned = (expr: TSApi.Expression | undefined): Set<string> | undefined => {
    if (expr === undefined) return new Set()
    let inner = expr
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression
    if (ts.isObjectLiteralExpression(inner)) return literalKeys(ts, inner)
    if (ts.isIdentifier(inner) && inner.text === "undefined") return new Set()
    if (ts.isVoidExpression(inner)) return new Set()
    return undefined
  }
  let handlers: Set<string> | undefined
  if (!ts.isBlock(setup.body)) handlers = returned(setup.body)
  else {
    handlers = new Set()
    const walkReturns = (node: TSApi.Node): void => {
      if (isEnhancerFn(ts, node) || ts.isFunctionDeclaration(node)) return
      if (ts.isReturnStatement(node)) {
        const keys = returned(node.expression)
        if (keys === undefined) handlers = undefined
        else for (const key of keys) handlers?.add(key)
      }
      ts.forEachChild(node, walkReturns)
    }
    ts.forEachChild(setup.body, walkReturns)
  }
  return { kind: "bind", state, handlers }
}

/** What an enhancer expression mounts: a `bindIsland(...)`, an imperative enhancer, or unknown. */
function enhancerNames(
  ts: typeof TSApi,
  expr: TSApi.Expression,
  locals: ReadonlyMap<string, TSApi.Expression>,
): IslandNames | typeof UNKNOWN {
  let target: TSApi.Expression | undefined = expr
  if (ts.isIdentifier(expr)) target = locals.get(expr.text)
  if (target === undefined) return UNKNOWN
  if (isEnhancerFn(ts, target)) return { kind: "imperative" }
  if (ts.isCallExpression(target) && ts.isIdentifier(target.expression)) {
    if (target.expression.text === "defineIsland") return { kind: "imperative" }
    if (target.expression.text === "bindIsland") return bindIslandNames(ts, target.arguments[0])
  }
  return UNKNOWN
}

/** Every island id mounted in the project, with what its markup may name. An id mounted with
 * different or unresolvable enhancers maps to UNKNOWN. */
function mountedIslands(
  ts: typeof TSApi,
  trees: ReadonlyArray<TSApi.SourceFile>,
): Map<string, IslandNames | typeof UNKNOWN> {
  const ids = new Map<string, IslandNames | typeof UNKNOWN>()
  for (const tree of trees) {
    const locals = new Map<string, TSApi.Expression>()
    const mounts: TSApi.ObjectLiteralExpression[] = []
    const visit = (node: TSApi.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      )
        locals.set(node.name.text, node.initializer)
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "mountIslands"
      ) {
        const map = node.arguments[0]
        if (map !== undefined && ts.isObjectLiteralExpression(map)) mounts.push(map)
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
    for (const map of mounts) {
      for (const prop of map.properties) {
        let id: string | undefined
        let names: IslandNames | typeof UNKNOWN = UNKNOWN
        if (ts.isShorthandPropertyAssignment(prop)) {
          id = prop.name.text
          names = enhancerNames(ts, prop.name, locals)
        } else if (
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
        ) {
          id = prop.name.text
          names = enhancerNames(ts, prop.initializer, locals)
        }
        if (id === undefined) continue
        ids.set(id, ids.has(id) ? UNKNOWN : names)
      }
    }
  }
  return ids
}

/** One `data-bind-*` attribute in markup, with the island host it belongs to. */
interface MarkupBinding {
  readonly attribute: string
  /** Signal names (`handler: false`) or handler names (`handler: true`) the attribute refers to. */
  readonly names: ReadonlyArray<{ readonly name: string; readonly handler: boolean }>
  /** The nearest enclosing host's id: `null` when there is none, UNKNOWN when it is not literal. */
  readonly island: string | null | typeof UNKNOWN
  readonly node: TSApi.Node
}

// Where an interpolation sat in a template; an attribute value holding one is not literal.
const HOLE = "\u0000"

function bindingNames(attribute: string, value: string): MarkupBinding["names"] | undefined {
  if (value.includes(HOLE)) return undefined
  const kind = attribute.slice("data-bind-".length)
  if (kind === "text" || kind === "show" || kind === "value")
    return value.trim() === "" ? [] : [{ name: value.trim(), handler: false }]
  if (kind !== "class" && kind !== "attr" && kind !== "on") return undefined
  const out: Array<{ name: string; handler: boolean }> = []
  for (const part of value.split(",")) {
    const sep = part.indexOf(":")
    if (sep <= 0) continue
    const name = part.slice(sep + 1).trim()
    if (part.slice(0, sep).trim() && name) out.push({ name, handler: kind === "on" })
  }
  return out
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
])

/** The attributes of one tag's inside (`name a="1" b`), in order. */
function tagAttributes(inside: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let i = 0
  while (i < inside.length) {
    while (i < inside.length && /[\s/]/.test(inside.charAt(i))) i++
    const start = i
    while (i < inside.length && !/[\s/=>]/.test(inside.charAt(i))) i++
    const name = inside.slice(start, i).toLowerCase()
    if (name === "") break
    while (i < inside.length && /\s/.test(inside.charAt(i))) i++
    let value = ""
    if (inside.charAt(i) === "=") {
      i++
      while (i < inside.length && /\s/.test(inside.charAt(i))) i++
      const quote = inside.charAt(i)
      if (quote === '"' || quote === "'") {
        const end = inside.indexOf(quote, i + 1)
        const stop = end < 0 ? inside.length : end
        value = inside.slice(i + 1, stop)
        i = stop + 1
      } else {
        const begin = i
        while (i < inside.length && !/\s/.test(inside.charAt(i))) i++
        value = inside.slice(begin, i)
      }
    }
    out.push([name, value])
  }
  return out
}

/** The `data-bind-*` attributes of an `html` template's text, and whether it holds an island host.
 * A linear scan: an unclosed tag ends it. */
function templateBindings(
  text: string,
  node: TSApi.Node,
): { readonly hasHost: boolean; readonly bindings: MarkupBinding[] } {
  const stack: Array<{ readonly tag: string; readonly island: string | null | typeof UNKNOWN }> = []
  const bindings: MarkupBinding[] = []
  let hasHost = false
  const owner = (): string | null | typeof UNKNOWN => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const island = stack[i]?.island ?? null
      if (island !== null) return island
    }
    return null
  }
  let at = text.indexOf("<")
  while (at >= 0) {
    let end = at + 1
    let quote = ""
    while (end < text.length) {
      const c = text.charAt(end)
      if (quote !== "") {
        if (c === quote) quote = ""
      } else if (c === '"' || c === "'") quote = c
      else if (c === ">") break
      end++
    }
    if (end >= text.length) break
    const inside = text.slice(at + 1, end)
    at = text.indexOf("<", end + 1)
    if (inside.startsWith("/")) {
      const tag = inside.slice(1).trim().toLowerCase()
      const open = stack.map((entry) => entry.tag).lastIndexOf(tag)
      if (open >= 0) stack.length = open
      continue
    }
    const tag = /^[a-zA-Z][\w-]*/.exec(inside)?.[0]?.toLowerCase()
    if (tag === undefined) continue
    const attributes = tagAttributes(inside.slice(tag.length))
    const hostId = attributes.find(([name]) => name === "data-island")?.[1]
    const island = hostId === undefined ? null : hostId.includes(HOLE) ? UNKNOWN : hostId
    if (island !== null) hasHost = true
    for (const [name, value] of attributes) {
      if (!name.startsWith("data-bind-")) continue
      const names = bindingNames(name, value)
      if (names !== undefined) bindings.push({ attribute: name, names, island: owner(), node })
    }
    if (!VOID_ELEMENTS.has(tag) && !inside.trimEnd().endsWith("/")) stack.push({ tag, island })
  }
  return { hasHost, bindings }
}

/** The text of an `html\`...\`` template, each interpolation replaced by HOLE. */
function templateText(ts: typeof TSApi, template: TSApi.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text
  let text = template.head.text
  for (const span of template.templateSpans) text += HOLE + span.literal.text
  return text
}

/** The literal string value of a JSX attribute, `undefined` when absent, UNKNOWN when not literal. */
function jsxAttribute(
  ts: typeof TSApi,
  element: TSApi.JsxOpeningLikeElement,
  name: string,
): string | undefined | typeof UNKNOWN {
  for (const attr of element.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attr)) continue
    if (attr.name.getText() !== name) continue
    const init = attr.initializer
    if (init === undefined) return ""
    if (ts.isStringLiteral(init)) return init.text
    if (
      ts.isJsxExpression(init) &&
      init.expression !== undefined &&
      ts.isStringLiteralLike(init.expression)
    )
      return init.expression.text
    return UNKNOWN
  }
  return undefined
}

/** The `data-bind-*` attributes of one outermost JSX tree, and whether it holds an island host. */
function jsxBindings(
  ts: typeof TSApi,
  root: TSApi.JsxElement | TSApi.JsxSelfClosingElement | TSApi.JsxFragment,
): { readonly hasHost: boolean; readonly bindings: MarkupBinding[] } {
  const bindings: MarkupBinding[] = []
  let hasHost = false
  const walk = (node: TSApi.Node, island: string | null | typeof UNKNOWN): void => {
    let opening: TSApi.JsxOpeningLikeElement | undefined
    if (ts.isJsxElement(node)) opening = node.openingElement
    else if (ts.isJsxSelfClosingElement(node)) opening = node
    let inner = island
    if (opening !== undefined) {
      const isIslandComponent = opening.tagName.getText() === "Island"
      const host = isIslandComponent
        ? jsxAttribute(ts, opening, "id")
        : jsxAttribute(ts, opening, "data-island")
      if (host !== undefined) {
        hasHost = true
        inner = host
      }
      for (const attr of opening.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attr)) continue
        const name = attr.name.getText()
        if (!name.startsWith("data-bind-")) continue
        const value = jsxAttribute(ts, opening, name)
        if (value === UNKNOWN || value === undefined) continue
        const names = bindingNames(name, value)
        if (names !== undefined) bindings.push({ attribute: name, names, island, node: attr })
      }
    }
    ts.forEachChild(node, (child) => walk(child, inner))
  }
  walk(root, null)
  return { hasHost, bindings }
}

/** Every markup tree in the project that holds an island host, flattened to its bindings. */
function markupBindings(ts: typeof TSApi, tree: TSApi.SourceFile): MarkupBinding[] {
  const out: MarkupBinding[] = []
  const take = (found: { readonly hasHost: boolean; readonly bindings: MarkupBinding[] }): void => {
    // A fragment with no host of its own may render inside one elsewhere, so it is not judged.
    if (found.hasHost) out.push(...found.bindings)
  }
  const visit = (node: TSApi.Node): void => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      node.tag.text === "html"
    ) {
      take(templateBindings(templateText(ts, node.template), node))
    } else if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    ) {
      take(jsxBindings(ts, node))
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return out
}

interface MarkupFinding {
  readonly file: string
  readonly line: number
  readonly binding: MarkupBinding
  readonly islands: Map<string, IslandNames | typeof UNKNOWN>
}

// NF-C047 and NF-C048 judge the same bindings, so one walk of the project serves both.
const markupCache = new WeakMap<SourceIndex, MarkupFinding[]>()

/** Markup bindings across the project, each with the island map they are judged against. */
async function projectMarkup(
  ctx: Parameters<CheckRule["scan"]>[0],
  code: string,
  title: string,
): Promise<{ readonly diagnostics?: readonly Diagnostic[]; readonly found: MarkupFinding[] }> {
  const loaded = await loadRuleTypeScript(ctx)
  if (loaded.diagnostics !== undefined) return { diagnostics: loaded.diagnostics, found: [] }
  const ts = loaded.compiler
  if (ts === undefined) return { diagnostics: [toolchainMissing(code, title)], found: [] }
  const cached = markupCache.get(ctx.project.source)
  if (cached !== undefined) return { found: cached }
  const trees: Array<{ readonly file: string; readonly tree: TSApi.SourceFile }> = []
  for (const file of ctx.project.source.files) {
    const tree = parsedTree(ts, ctx.project.source, file)
    if (tree !== undefined) trees.push({ file, tree })
  }
  const islands = mountedIslands(
    ts,
    trees.map((entry) => entry.tree),
  )
  const found: MarkupFinding[] = []
  for (const { file, tree } of trees)
    for (const binding of markupBindings(ts, tree))
      found.push({ file, line: lineOf(tree, binding.node), binding, islands })
  markupCache.set(ctx.project.source, found)
  return { found }
}

export const islandBindingNameRule: CheckRule = {
  code: "NF-C047",
  title: "Island binding name check",
  async scan(ctx) {
    const { diagnostics, found } = await projectMarkup(ctx, "NF-C047", "Island binding name check")
    if (diagnostics !== undefined) return diagnostics
    const findings: Diagnostic[] = []
    for (const { file, line, binding, islands } of found) {
      if (typeof binding.island !== "string") continue
      const names = islands.get(binding.island)
      if (names === undefined || names === UNKNOWN || names.kind !== "bind") continue
      for (const { name, handler } of binding.names) {
        const known = handler ? names.handlers : names.state
        if (known === undefined || known.has(name)) continue
        findings.push(
          diagnostic({
            code: "NF-C047",
            severity: "warn",
            file,
            line,
            message: handler
              ? `${binding.attribute} names handler "${name}", which the bindIsland setup mounted as "${binding.island}" does not return - the listener is never added`
              : `${binding.attribute} names "${name}", which the bindIsland setup mounted as "${binding.island}" never declares with state("${name}", ...) - the binding is skipped`,
            evidence: [`${binding.attribute} -> ${name}`],
            fix: { recipe: "islands.binding-names", command: "nifra_docs islands" },
            verify: "nifra check --lints-only",
          }),
        )
      }
    }
    return findings
  },
}

export const islandBindingHostRule: CheckRule = {
  code: "NF-C048",
  title: "Island binding outside a bindIsland host",
  async scan(ctx) {
    const { diagnostics, found } = await projectMarkup(
      ctx,
      "NF-C048",
      "Island binding outside a bindIsland host",
    )
    if (diagnostics !== undefined) return diagnostics
    const findings: Diagnostic[] = []
    for (const { file, line, binding, islands } of found) {
      let reason: string | undefined
      if (binding.island === null) reason = "it sits outside every data-island host"
      else if (typeof binding.island === "string") {
        const names = islands.get(binding.island)
        if (names !== undefined && names !== UNKNOWN && names.kind === "imperative")
          reason = `island "${binding.island}" is mounted with an imperative enhancer, which runs no bindings`
      }
      if (reason === undefined) continue
      findings.push(
        diagnostic({
          code: "NF-C048",
          severity: "warn",
          file,
          line,
          message: `${binding.attribute} never binds: ${reason}. Move it inside a host mounted with bindIsland`,
          evidence: [binding.attribute],
          fix: { recipe: "islands.binding-host", command: "nifra_docs islands" },
          verify: "nifra check --lints-only",
        }),
      )
    }
    return findings
  },
}

export const islandRules = Object.freeze([
  islandCleanupRule,
  islandListKeyRule,
  islandBindingNameRule,
  islandBindingHostRule,
])
