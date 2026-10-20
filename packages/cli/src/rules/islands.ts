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

// The calls that mount islands from an enhancer map.
const MOUNT_CALLS = new Set(["mountIslands", "enableSwap"])

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
 * function-typed value of a `mountIslands({ ... })` or `enableSwap({ ... })` object literal. */
function enhancerFns(ts: typeof TSApi, tree: TSApi.SourceFile): EnhancerFn[] {
  const out: EnhancerFn[] = []
  const visit = (node: TSApi.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text
      if (callee === "defineIsland") {
        const arg = node.arguments[0]
        if (arg !== undefined && isEnhancerFn(ts, arg)) out.push(arg)
      } else if (MOUNT_CALLS.has(callee)) {
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

export const lineOf = (tree: TSApi.SourceFile, node: TSApi.Node): number =>
  tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1

export function toolchainMissing(code: string, title: string): Diagnostic {
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

export const UNKNOWN = Symbol("unknown")

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

/** Whether `node` names a property (`x.state`, `{ state: 1 }`, `{ state() {} }`) rather than a value. */
function isPropertyName(ts: typeof TSApi, node: TSApi.Identifier): boolean {
  const parent = node.parent
  return (
    ((ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node)
  )
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
  const ctxProperty = (node: TSApi.Node): node is TSApi.PropertyAccessExpression =>
    ctxName !== undefined &&
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === ctxName
  // The keys are known only while `state` is called directly: an alias, a destructuring or a helper
  // that receives `state` or the context may declare keys this walk cannot see.
  const walk = (node: TSApi.Node): void => {
    if (state === undefined) return
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (
        (ts.isIdentifier(callee) && callee.text === stateName) ||
        (ctxProperty(callee) && callee.name.text === "state")
      ) {
        const key = node.arguments[0]
        if (key !== undefined && ts.isStringLiteralLike(key)) state.add(key.text)
        else state = undefined
        for (const arg of node.arguments) walk(arg)
        return
      }
    }
    // `ctx.root`, `ctx.props` and `ctx.onDispose` reach no state; `ctx.state` read as a value does.
    if (ctxProperty(node)) {
      if (node.name.text === "state") state = undefined
      return
    }
    if (ts.isIdentifier(node)) {
      if ((node.text === stateName || node.text === ctxName) && !isPropertyName(ts, node))
        state = undefined
      return
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
        MOUNT_CALLS.has(node.expression.text)
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
  /** A `data-swap-slot` between the binding and its host, whose swap replaces the bound element. */
  readonly slot: string | null | typeof UNKNOWN
  readonly node: TSApi.Node
}

/** A `data-swap` link or form, or a `data-swap-slot` element. */
export interface SwapMarkup {
  readonly kind: "swap" | "slot"
  readonly tag: string
  /** The attribute's value: UNKNOWN when it is not literal. */
  readonly value: string | typeof UNKNOWN
  /** A link's `href` or a form's `action`, interpolations as HOLE: `undefined` when absent, UNKNOWN
   * when a JSX value is not literal. */
  readonly url: string | undefined | typeof UNKNOWN
  /** A slot's content in an `html` template, interpolations as HOLE, with their expressions in
   * order. Absent in JSX and when the element does not close in its template. */
  content?: { readonly text: string; readonly holes: readonly TSApi.Expression[] }
  readonly jsx: boolean
  readonly node: TSApi.Node
}

/** Where an interpolation of an `html` template sits: inside which slot, and whether it is the
 * slot's whole content. */
export interface HolePlacement {
  readonly slot: string | null | typeof UNKNOWN
  readonly sole: boolean
}

interface MarkupFacts {
  readonly hasHost: boolean
  readonly bindings: MarkupBinding[]
  readonly swaps: SwapMarkup[]
}

// Where an interpolation sat in a template; an attribute value holding one is not literal.
export const HOLE = "\u0000"

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

interface OpenElement {
  readonly tag: string
  readonly island: string | null | typeof UNKNOWN
  readonly slot: SwapMarkup | undefined
  /** Where the element's content starts in the template text. */
  readonly start: number
}

/** The island a binding belongs to, and a slot between them, from the elements open around it. */
function ownerOf(stack: readonly OpenElement[]): Pick<MarkupBinding, "island" | "slot"> {
  let slot: string | null | typeof UNKNOWN = null
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i]
    if (entry === undefined) continue
    if (entry.slot !== undefined && slot === null) slot = entry.slot.value
    if (entry.island !== null) return { island: entry.island, slot }
  }
  return { island: null, slot: null }
}

/**
 * The bindings, swap links, forms and slots of an `html` template's text, and whether it holds an
 * island host. `holes` are the template's interpolations, in order; `placement` learns where each
 * one sits. A linear scan: an unclosed tag ends it.
 */
function templateMarkup(
  text: string,
  holes: readonly TSApi.Expression[],
  node: TSApi.Node,
  placement: Map<TSApi.Node, HolePlacement>,
): MarkupFacts {
  const stack: OpenElement[] = []
  const bindings: MarkupBinding[] = []
  const swaps: SwapMarkup[] = []
  const positions: number[] = []
  for (let i = text.indexOf(HOLE); i >= 0; i = text.indexOf(HOLE, i + 1)) positions.push(i)
  const holesIn = (from: number, to: number): TSApi.Expression[] => {
    const out: TSApi.Expression[] = []
    positions.forEach((position, i) => {
      const hole = holes[i]
      if (position >= from && position < to && hole !== undefined) out.push(hole)
    })
    return out
  }
  // Innermost first, so each interpolation is placed in the element nearest to it.
  const close = (from: number, at: number): void => {
    for (let i = stack.length - 1; i >= from; i--) {
      const entry = stack[i]
      if (entry === undefined) continue
      const inside = holesIn(entry.start, at)
      const sole = entry.slot !== undefined && text.slice(entry.start, at).trim() === HOLE
      for (const hole of inside)
        if (!placement.has(hole)) placement.set(hole, { slot: entry.slot?.value ?? null, sole })
      if (entry.slot !== undefined)
        entry.slot.content = { text: text.slice(entry.start, at), holes: inside }
    }
    stack.length = from
  }
  let hasHost = false
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
    // An interpolation in a tag is an attribute value, never content.
    for (const hole of holesIn(at, end)) placement.set(hole, { slot: null, sole: false })
    const tagAt = at
    at = text.indexOf("<", end + 1)
    if (inside.startsWith("/")) {
      const tag = inside.slice(1).trim().toLowerCase()
      const open = stack.map((entry) => entry.tag).lastIndexOf(tag)
      if (open >= 0) close(open, tagAt)
      continue
    }
    const tag = /^[a-zA-Z][\w-]*/.exec(inside)?.[0]?.toLowerCase()
    if (tag === undefined) continue
    const attributes = tagAttributes(inside.slice(tag.length))
    const attribute = (name: string): string | undefined =>
      attributes.find(([key]) => key === name)?.[1]
    const literal = (value: string): string | typeof UNKNOWN =>
      value.includes(HOLE) ? UNKNOWN : value
    const hostId = attribute("data-island")
    const island = hostId === undefined ? null : literal(hostId)
    if (island !== null) hasHost = true
    const owner = ownerOf(stack)
    for (const [name, value] of attributes) {
      if (!name.startsWith("data-bind-")) continue
      const names = bindingNames(name, value)
      if (names !== undefined) bindings.push({ attribute: name, names, ...owner, node })
    }
    const swap = attribute("data-swap")
    const url = tag === "a" ? attribute("href") : tag === "form" ? attribute("action") : undefined
    if (swap !== undefined)
      swaps.push({ kind: "swap", tag, value: literal(swap), url, jsx: false, node })
    const slotName = attribute("data-swap-slot")
    const slot: SwapMarkup | undefined =
      slotName === undefined
        ? undefined
        : { kind: "slot", tag, value: literal(slotName), url: undefined, jsx: false, node }
    if (slot !== undefined) swaps.push(slot)
    if (!VOID_ELEMENTS.has(tag) && !inside.trimEnd().endsWith("/"))
      stack.push({ tag, island, slot, start: end + 1 })
  }
  return { hasHost, bindings, swaps }
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

/** The bindings, swap links, forms and slots of one outermost JSX tree, and whether it holds an
 * island host. */
function jsxMarkup(
  ts: typeof TSApi,
  root: TSApi.JsxElement | TSApi.JsxSelfClosingElement | TSApi.JsxFragment,
): MarkupFacts {
  const bindings: MarkupBinding[] = []
  const swaps: SwapMarkup[] = []
  let hasHost = false
  const walk = (node: TSApi.Node, owner: Pick<MarkupBinding, "island" | "slot">): void => {
    let opening: TSApi.JsxOpeningLikeElement | undefined
    if (ts.isJsxElement(node)) opening = node.openingElement
    else if (ts.isJsxSelfClosingElement(node)) opening = node
    let inner = owner
    if (opening !== undefined) {
      const tag = opening.tagName.getText()
      const host =
        tag === "Island"
          ? jsxAttribute(ts, opening, "id")
          : jsxAttribute(ts, opening, "data-island")
      if (host !== undefined) {
        hasHost = true
        inner = { island: host, slot: null }
      }
      for (const attr of opening.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attr)) continue
        const name = attr.name.getText()
        if (!name.startsWith("data-bind-")) continue
        const value = jsxAttribute(ts, opening, name)
        if (value === UNKNOWN || value === undefined) continue
        const names = bindingNames(name, value)
        if (names !== undefined) bindings.push({ attribute: name, names, ...owner, node: attr })
      }
      const swap = jsxAttribute(ts, opening, "data-swap")
      if (swap !== undefined) {
        const url =
          tag === "a"
            ? jsxAttribute(ts, opening, "href")
            : tag === "form"
              ? jsxAttribute(ts, opening, "action")
              : undefined
        swaps.push({ kind: "swap", tag, value: swap, url, jsx: true, node: opening })
      }
      const slot = jsxAttribute(ts, opening, "data-swap-slot")
      if (slot !== undefined) {
        swaps.push({ kind: "slot", tag, value: slot, url: undefined, jsx: true, node: opening })
        inner = { island: inner.island, slot }
      }
    }
    ts.forEachChild(node, (child) => walk(child, inner))
  }
  walk(root, { island: null, slot: null })
  return { hasHost, bindings, swaps }
}

/** The `slot` names a file imports from `@nifrajs/web-vanilla`. */
function slotImports(ts: typeof TSApi, tree: TSApi.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@nifrajs/web-vanilla"
    )
      continue
    const bound = statement.importClause?.namedBindings
    if (bound === undefined || !ts.isNamedImports(bound)) continue
    for (const element of bound.elements)
      if ((element.propertyName ?? element.name).text === "slot") names.add(element.name.text)
  }
  return names
}

/** One `slot(name, content)` call of `@nifrajs/web-vanilla`. */
export interface SlotCall {
  readonly name: string | typeof UNKNOWN
  readonly node: TSApi.CallExpression
}

/** The markup of one file: every tree's bindings (those with a host), swap uses and slot calls. */
function fileMarkup(
  ts: typeof TSApi,
  tree: TSApi.SourceFile,
): {
  readonly bindings: MarkupBinding[]
  readonly swaps: SwapMarkup[]
  readonly slotCalls: SlotCall[]
  readonly placement: Map<TSApi.Node, HolePlacement>
} {
  const bindings: MarkupBinding[] = []
  const swaps: SwapMarkup[] = []
  const slotCalls: SlotCall[] = []
  const placement = new Map<TSApi.Node, HolePlacement>()
  const slotNames = slotImports(ts, tree)
  const take = (found: MarkupFacts): void => {
    // A fragment with no host of its own may render inside one elsewhere, so it is not judged.
    if (found.hasHost) bindings.push(...found.bindings)
    swaps.push(...found.swaps)
  }
  const visit = (node: TSApi.Node): void => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      node.tag.text === "html"
    ) {
      const holes = ts.isTemplateExpression(node.template)
        ? node.template.templateSpans.map((span) => span.expression)
        : []
      take(templateMarkup(templateText(ts, node.template), holes, node, placement))
    } else if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    ) {
      take(jsxMarkup(ts, node))
      return
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      slotNames.has(node.expression.text)
    ) {
      const first = node.arguments[0]
      slotCalls.push({
        name: first !== undefined && ts.isStringLiteralLike(first) ? first.text : UNKNOWN,
        node,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return { bindings, swaps, slotCalls, placement }
}

interface MarkupFinding {
  readonly file: string
  readonly line: number
  readonly binding: MarkupBinding
  readonly islands: Map<string, IslandNames | typeof UNKNOWN>
}

/** A file's markup facts, for the swap rules. */
export interface FileMarkup {
  readonly file: string
  readonly tree: TSApi.SourceFile
  readonly swaps: readonly SwapMarkup[]
  readonly slotCalls: readonly SlotCall[]
  readonly placement: ReadonlyMap<TSApi.Node, HolePlacement>
}

export interface ProjectMarkup {
  readonly bindings: readonly MarkupFinding[]
  readonly files: readonly FileMarkup[]
}

// NF-C047, NF-C048 and the swap rules judge the same markup, so one walk of the project serves all.
const markupCache = new WeakMap<SourceIndex, ProjectMarkup>()

/** Markup across the project: each binding with the island map it is judged against, and each
 * file's swap facts. */
export async function projectMarkup(
  ctx: Parameters<CheckRule["scan"]>[0],
  code: string,
  title: string,
): Promise<{
  readonly diagnostics?: readonly Diagnostic[]
  readonly ts?: typeof TSApi
  readonly markup: ProjectMarkup
}> {
  const empty: ProjectMarkup = { bindings: [], files: [] }
  const loaded = await loadRuleTypeScript(ctx)
  if (loaded.diagnostics !== undefined) return { diagnostics: loaded.diagnostics, markup: empty }
  const ts = loaded.compiler
  if (ts === undefined) return { diagnostics: [toolchainMissing(code, title)], markup: empty }
  const cached = markupCache.get(ctx.project.source)
  if (cached !== undefined) return { ts, markup: cached }
  const trees: Array<{ readonly file: string; readonly tree: TSApi.SourceFile }> = []
  for (const file of ctx.project.source.files) {
    const tree = parsedTree(ts, ctx.project.source, file)
    if (tree !== undefined) trees.push({ file, tree })
  }
  const islands = mountedIslands(
    ts,
    trees.map((entry) => entry.tree),
  )
  const bindings: MarkupFinding[] = []
  const files: FileMarkup[] = []
  for (const { file, tree } of trees) {
    const found = fileMarkup(ts, tree)
    for (const binding of found.bindings)
      bindings.push({ file, line: lineOf(tree, binding.node), binding, islands })
    files.push({ file, tree, ...found })
  }
  const markup = { bindings, files }
  markupCache.set(ctx.project.source, markup)
  return { ts, markup }
}

export const islandBindingNameRule: CheckRule = {
  code: "NF-C047",
  title: "Island binding name check",
  async scan(ctx) {
    const { diagnostics, markup } = await projectMarkup(ctx, "NF-C047", "Island binding name check")
    if (diagnostics !== undefined) return diagnostics
    const findings: Diagnostic[] = []
    for (const { file, line, binding, islands } of markup.bindings) {
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
    const { diagnostics, markup } = await projectMarkup(
      ctx,
      "NF-C048",
      "Island binding outside a bindIsland host",
    )
    if (diagnostics !== undefined) return diagnostics
    const findings: Diagnostic[] = []
    for (const { file, line, binding, islands } of markup.bindings) {
      let message: string | undefined
      if (binding.island === null)
        message = `${binding.attribute} never binds: it sits outside every data-island host. Move it inside a host mounted with bindIsland`
      else if (typeof binding.island === "string") {
        const names = islands.get(binding.island)
        if (names !== undefined && names !== UNKNOWN && names.kind === "imperative")
          message = `${binding.attribute} never binds: island "${binding.island}" is mounted with an imperative enhancer, which runs no bindings. Move it inside a host mounted with bindIsland`
      }
      if (message === undefined && binding.island !== null && binding.slot !== null) {
        const slot = typeof binding.slot === "string" ? `"${binding.slot}"` : "around it"
        message = `${binding.attribute} sits in data-swap-slot ${slot} but belongs to an island outside it: a swap replaces its element and the binding stops. Bind it from an island inside the slot`
      }
      if (message === undefined) continue
      findings.push(
        diagnostic({
          code: "NF-C048",
          severity: "warn",
          file,
          line,
          message,
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
