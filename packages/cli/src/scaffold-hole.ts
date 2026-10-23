/**
 * `nifra scaffold hole <route> <name>`: add a partially prerendered hole to a route whose backend half
 * exports `shellLoader`. The page gets the hole's definition, its entry in `boundaries` and a `<Hole>`
 * where its markup ends; the backend half gets the hole's loader and output schema. Every edit lands
 * at a position the project's TypeScript parser found, and nothing is written unless every edit has
 * one. A Vue or Svelte page gets the code to paste instead.
 */
import { readFileSync } from "node:fs"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import type * as TS from "typescript"
import type { ProjectTypeScriptLoad } from "./internal/typescript-import.ts"
import { backendFileOf, type Framework, pageExtension, routePathToFile } from "./scaffold.ts"

export interface HoleScaffoldOptions {
  /** The same for every visitor: built once and kept on its own `revalidate`. */
  readonly shared?: boolean | undefined
  /** Ships its props and hydrates as its own root. */
  readonly interactive?: boolean | undefined
  /** The hole's deadline in milliseconds, 1 to 30000. */
  readonly timeout?: number | undefined
  /** Shows a server component, which the coordinated compiler builds. */
  readonly server?: boolean | undefined
}

export interface HoleScaffoldResult {
  readonly ok: boolean
  readonly page: string
  readonly backend: string
  /** Files written or created, relative to the app root. */
  readonly changed: readonly string[]
  /** Code to place by hand, for a page the scaffold does not edit. */
  readonly snippets: readonly { readonly file: string; readonly code: string }[]
  readonly next: readonly string[]
  /** Without `write`: each file as the scaffold would leave it. */
  readonly preview?: readonly { readonly file: string; readonly text: string }[]
  readonly reason?: string
}

/** The hole name rule `@nifrajs/web` enforces: a name becomes a DOM id and a hashed script. */
export const HOLE_NAME = /^(?=[a-z0-9-]{1,32}$)[a-z](?:-?[a-z0-9])*$/
export const MAX_HOLES = 32
export const ADAPTER: Partial<Record<Framework, string>> = {
  react: "@nifrajs/web-react/ppr",
  preact: "@nifrajs/web-preact/ppr",
  solid: "@nifrajs/web-solid/ppr",
}

export interface Edit {
  readonly at: number
  readonly text: string
  /** Characters the edit replaces, from `at`. */
  readonly remove?: number
}

/** `cart-count` → `cartCount`. */
const camel = (name: string): string =>
  name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
const pascal = (name: string): string => {
  const value = camel(name)
  return value.charAt(0).toUpperCase() + value.slice(1)
}
/** A property key or access for `name`: bare when it is an identifier, quoted when it has a hyphen. */
const keyOf = (name: string): string => (name.includes("-") ? JSON.stringify(name) : name)
const accessOf = (name: string): string =>
  name.includes("-") ? `?.[${JSON.stringify(name)}]` : `?.${name}`

/** `edits` applied to `source`; edits at one position land in the order they are listed. */
export function apply(source: string, edits: readonly Edit[]): string {
  let out = source
  const order = edits.map((edit, index) => ({ edit, index }))
  for (const { edit } of order.sort((a, b) => b.edit.at - a.edit.at || b.index - a.index)) {
    out = out.slice(0, edit.at) + edit.text + out.slice(edit.at + (edit.remove ?? 0))
  }
  return out
}

/** Leading whitespace of the line `pos` is on. */
export function indentAt(source: string, pos: number): string {
  const start = source.lastIndexOf("\n", pos - 1) + 1
  return /^[ \t]*/.exec(source.slice(start))?.[0] ?? ""
}

/** Whether only whitespace sits between the start of `pos`'s line and `pos`. */
function ownLine(source: string, pos: number): boolean {
  const start = source.lastIndexOf("\n", pos - 1) + 1
  return source.slice(start, pos).trim() === ""
}

/** Read from `node.modifiers`: TypeScript 7's API has no `getModifiers`. */
const hasModifier = (
  node: TS.VariableStatement | TS.FunctionDeclaration,
  kind: TS.SyntaxKind,
): boolean => node.modifiers?.some((modifier) => modifier.kind === kind) === true
const hasExport = (ts: typeof TS, node: TS.VariableStatement | TS.FunctionDeclaration): boolean =>
  hasModifier(node, ts.SyntaxKind.ExportKeyword)

/** An exported `const <name> = <initializer>`, its initializer without `as`, `satisfies` or parens. */
function exportedConst(
  ts: typeof TS,
  sf: TS.SourceFile,
  name: string,
):
  | { readonly statement: TS.VariableStatement; readonly value: TS.Expression | undefined }
  | undefined {
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement) || !hasExport(ts, statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
      let value = declaration.initializer
      while (
        value !== undefined &&
        (ts.isAsExpression(value) ||
          ts.isSatisfiesExpression(value) ||
          ts.isParenthesizedExpression(value))
      )
        value = value.expression
      return { statement, value }
    }
  }
  return undefined
}

function exportsName(ts: typeof TS, sf: TS.SourceFile, name: string): boolean {
  return (
    exportedConst(ts, sf, name) !== undefined ||
    sf.statements.some(
      (statement) =>
        ts.isFunctionDeclaration(statement) &&
        hasExport(ts, statement) &&
        statement.name?.text === name,
    )
  )
}

const propertyName = (ts: typeof TS, name: TS.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : undefined

/** Every name a module's top level binds, so a new one cannot shadow or clash. */
export function topLevelNames(ts: typeof TS, sf: TS.SourceFile): Set<string> {
  const names = new Set<string>()
  const bind = (name: TS.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text)
    else
      for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name)
  }
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) bind(declaration.name)
    else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name !== undefined
    )
      names.add(statement.name.text)
    else if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
      const clause = statement.importClause
      if (clause.name !== undefined) names.add(clause.name.text)
      const bindings = clause.namedBindings
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.add(bindings.name.text)
      if (bindings !== undefined && ts.isNamedImports(bindings))
        for (const element of bindings.elements) names.add(element.name.text)
    }
  }
  return names
}

/** A named import a planned edit needs: `name` is the local binding, `imported` the export's name. */
export interface ImportNeed {
  readonly module: string
  readonly name: string
  readonly imported?: string
  readonly typeOnly?: boolean
}

/** The edit that makes `need` importable, or none when it already is. */
function ensureImport(ts: typeof TS, sf: TS.SourceFile, need: ImportNeed): Edit | undefined {
  const { module, name } = need
  const typeOnly = need.typeOnly === true
  const named =
    need.imported === undefined || need.imported === name ? name : `${need.imported} as ${name}`
  let last: TS.ImportDeclaration | undefined
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    last = statement
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== module)
      continue
    const clause = statement.importClause
    const bindings = clause?.namedBindings
    if (clause === undefined || bindings === undefined || !ts.isNamedImports(bindings)) continue
    if (bindings.elements.some((element) => element.name.text === name)) return undefined
    // A type-only declaration takes a type name as it is; a value one needs `type` on it.
    if (!typeOnly && clause.isTypeOnly) continue
    const specifier = typeOnly && !clause.isTypeOnly ? `type ${named}` : named
    const lastElement = bindings.elements.at(-1)
    return lastElement === undefined
      ? { at: bindings.getEnd() - 1, text: specifier }
      : { at: lastElement.getEnd(), text: `, ${specifier}` }
  }
  const line = `import ${typeOnly ? "type " : ""}{ ${named} } from ${JSON.stringify(module)}\n`
  return last === undefined
    ? { at: 0, text: line }
    : { at: last.getEnd(), text: `\n${line.trimEnd()}` }
}

interface Plan {
  readonly edits: Edit[]
  reason?: string
}

/** A hole's loader: the lines inside its `boundaryLoaders` entry, and the imports they use. */
export interface LoaderEntry {
  readonly body: readonly string[]
  readonly imports: readonly ImportNeed[]
}

/** The TODO loader the scaffold writes. */
function scaffoldLoader(options: HoleScaffoldOptions): LoaderEntry {
  const context = options.shared === true ? "SharedHoleCtx" : "BoundaryRequestCtx"
  const load =
    options.server === true
      ? `load: ({ params }: ${context}) => ({ id: params.id ?? "" }),\noutput: t.object({ id: t.string() }),`
      : `load: (_ctx: ${context}) => ({ text: "TODO" }),\noutput: t.object({ text: t.string() }),`
  const comment =
    options.server === true
      ? "// Returns the server component's input, which reaches the browser in its record."
      : options.shared === true
        ? "// The same for every visitor: no request; built once and kept for `revalidate` seconds."
        : "// Runs for each visitor, under the hole's own deadline."
  return {
    body: [comment, ...load.split("\n"), ...(options.shared === true ? ["revalidate: 60,"] : [])],
    imports: [
      { module: "@nifrajs/schema", name: "t" },
      { module: "@nifrajs/web", name: context, typeOnly: true },
    ],
  }
}

/** The backend half's edits: hole `name`'s loader entry, and the imports it uses. */
export function backendPlan(
  ts: typeof TS,
  sf: TS.SourceFile,
  name: string,
  loader: LoaderEntry,
): Plan & { readonly keys: readonly string[] } {
  const source = sf.text
  const edits: Edit[] = []
  const entry = (indent: string): string =>
    [
      `${indent}${keyOf(name)}: {`,
      ...loader.body.map((line) => `${indent}  ${line}`),
      `${indent}},`,
    ].join("\n")

  const loaders = exportedConst(ts, sf, "boundaryLoaders")
  let keys: string[] = []
  if (loaders === undefined) {
    const satisfies = /import\s+type\s*\{[^}]*\bRoute\b[^}]*\}\s*from\s*["']\.\/\+types\//.test(
      source,
    )
      ? " satisfies Route.BoundaryLoaders"
      : ""
    edits.push({
      at: source.trimEnd().length,
      text: `\n\nexport const boundaryLoaders = {\n${entry("  ")}\n}${satisfies}`,
    })
  } else {
    const object = loaders.value
    if (object === undefined || !ts.isObjectLiteralExpression(object))
      return { edits, keys, reason: "`boundaryLoaders` is not an object literal" }
    keys = object.properties.flatMap((property) => {
      const key = property.name === undefined ? undefined : propertyName(ts, property.name)
      return key === undefined ? [] : [key]
    })
    const close = object.getEnd() - 1
    const lastProperty = object.properties.at(-1)
    if (lastProperty === undefined) {
      edits.push({
        at: object.getStart(sf),
        remove: object.getWidth(sf),
        text: `{\n${entry("  ")}\n}`,
      })
    } else if (ownLine(source, close)) {
      const indent = indentAt(source, lastProperty.getStart(sf))
      if (!object.properties.hasTrailingComma) edits.push({ at: lastProperty.getEnd(), text: "," })
      const lineStart = source.lastIndexOf("\n", close - 1) + 1
      edits.push({ at: lineStart, text: `${entry(indent)}\n` })
    } else {
      return {
        edits,
        keys,
        reason: "`boundaryLoaders` is written on one line; spread it over lines first",
      }
    }
  }
  for (const need of loader.imports) {
    const edit = ensureImport(ts, sf, need)
    if (edit !== undefined) edits.push(edit)
  }
  return { edits, keys }
}

/** The component a page module exports as default, as a function node. */
export function defaultComponent(
  ts: typeof TS,
  sf: TS.SourceFile,
): TS.FunctionDeclaration | TS.ArrowFunction | TS.FunctionExpression | undefined {
  const local = (
    name: string,
  ): TS.FunctionDeclaration | TS.ArrowFunction | TS.FunctionExpression | undefined => {
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name &&
          value !== undefined &&
          (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
        )
          return value
      }
    }
    return undefined
  }
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword))
      return statement
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const value = statement.expression
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value
      if (ts.isIdentifier(value)) return local(value.text)
    }
  }
  return undefined
}

/** The JSX a component returns: its one top-level `return`, or an arrow's expression body. */
export function returnedJsx(
  ts: typeof TS,
  component: TS.FunctionDeclaration | TS.ArrowFunction | TS.FunctionExpression,
): TS.JsxElement | TS.JsxFragment | undefined {
  let value: TS.Expression | undefined
  const body = component.body
  if (body === undefined) return undefined
  if (ts.isBlock(body)) {
    const returns = body.statements.filter(ts.isReturnStatement)
    if (returns.length !== 1) return undefined
    value = returns[0]?.expression
  } else value = body
  while (value !== undefined && ts.isParenthesizedExpression(value)) value = value.expression
  return value !== undefined && (ts.isJsxElement(value) || ts.isJsxFragment(value))
    ? value
    : undefined
}

/** Every name a function binds, in its parameters and anywhere in its body. */
export function localNames(ts: typeof TS, fn: TS.Node, into: Set<string>): void {
  const visit = (node: TS.Node): void => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    )
      into.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(fn)
}

/** A hole's definition in the page: its fields after `name`, and the imports they use. */
export interface HoleDefinition {
  readonly fields: readonly string[]
  readonly imports: readonly ImportNeed[]
  /** The JSX the `<Hole>` takes the place of; without it, the hole goes where the markup ends. */
  readonly replaces?: TS.Node
}

/** A placeholder fallback: without one, a browser without JavaScript shows nothing in the hole. */
export const fallbackField = (framework: Framework): string =>
  // Solid: a function, since JSX evaluated at import would be one DOM node every page shares.
  framework === "solid" ? "fallback: () => <p>Loading</p>," : "fallback: <p>Loading</p>,"

/** The definition the scaffold writes: a TODO render, or the server component's. */
function scaffoldDefinition(
  framework: Framework,
  options: HoleScaffoldOptions,
  component: { readonly name: string; readonly specifier: string } | undefined,
): HoleDefinition {
  return {
    fields: [
      `mode: "${options.shared === true ? "shared" : "dynamic"}",`,
      ...(options.interactive === true
        ? ["interactive: true, // ships its props and hydrates as its own root"]
        : []),
      ...(options.timeout === undefined ? [] : [`timeout: ${options.timeout},`]),
      component === undefined
        ? "render: (data: { readonly text: string }) => <p>{data.text}</p>,"
        : `render: serverHole(${component.name}),`,
      fallbackField(framework),
    ],
    imports:
      component === undefined
        ? []
        : [
            { module: "@nifrajs/web/server-components/hole", name: "serverHole" },
            { module: component.specifier, name: component.name },
          ],
  }
}

/** The page's edits, for a JSX-family page: the definition, `boundaries`, imports and the `<Hole>`. */
export function pagePlan(
  ts: typeof TS,
  sf: TS.SourceFile,
  name: string,
  framework: Framework,
  definition: HoleDefinition,
): Plan & { readonly names: readonly string[]; readonly ident: string } {
  const source = sf.text
  const edits: Edit[] = []
  // Listed first: the definition can land where the imports end, and goes below them.
  const imports: Edit[] = []
  const taken = topLevelNames(ts, sf)
  let ident = camel(name)
  const none: readonly string[] = []
  const refuse = (reason: string) => ({ edits, names: none, ident, reason })

  const boundaries = exportedConst(ts, sf, "boundaries")
  const names: string[] = []
  if (boundaries !== undefined) {
    const list = boundaries.value
    if (list === undefined || !ts.isArrayLiteralExpression(list))
      return refuse("`boundaries` is not an array literal")
    for (const element of list.elements) {
      // A boundary written inline, or declared in this module, names itself in its `name` field.
      let value: TS.Expression | undefined = element
      if (ts.isIdentifier(element)) {
        value = undefined
        for (const statement of sf.statements)
          if (ts.isVariableStatement(statement))
            for (const declaration of statement.declarationList.declarations)
              if (ts.isIdentifier(declaration.name) && declaration.name.text === element.text)
                value = declaration.initializer
      }
      while (value !== undefined && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)))
        value = value.expression
      if (value === undefined || !ts.isObjectLiteralExpression(value)) continue
      for (const property of value.properties)
        if (
          ts.isPropertyAssignment(property) &&
          propertyName(ts, property.name) === "name" &&
          ts.isStringLiteralLike(property.initializer)
        )
          names.push(property.initializer.text)
    }
    if (list.elements.length >= MAX_HOLES)
      return refuse(
        `the page already declares ${list.elements.length} boundaries, the most a route may have`,
      )
  }

  const page = defaultComponent(ts, sf)
  if (page === undefined) return refuse("the page has no default-exported component")
  const jsx = returnedJsx(ts, page)
  if (jsx === undefined)
    return refuse("the page component does not return one JSX element the hole can go inside")
  // The definition is a module name the component reads, so a name of the component's own shadows it.
  localNames(ts, page, taken)
  if (taken.has(ident)) ident = `${ident}Hole`
  if (taken.has(ident)) return refuse(`\`${ident}\` is already declared in the page`)

  // How the component reads its boundary states.
  const param = page.parameters[0]
  if (param === undefined) return refuse("the page component takes no props")
  let states: string
  if (ts.isIdentifier(param.name)) states = `${param.name.text}.boundaries`
  else if (ts.isObjectBindingPattern(param.name)) {
    const bound = param.name.elements.find(
      (element) =>
        (element.propertyName === undefined
          ? ts.isIdentifier(element.name) && element.name.text
          : propertyName(ts, element.propertyName)) === "boundaries",
    )
    if (bound !== undefined && !ts.isIdentifier(bound.name))
      return refuse("the page destructures `boundaries` further")
    if (bound !== undefined && ts.isIdentifier(bound.name)) states = bound.name.text
    else {
      states = taken.has("boundaries") ? "" : "boundaries"
      if (states === "") return refuse("`boundaries` is already a name in the page")
      if (param.name.elements.some((element) => element.dotDotDotToken !== undefined))
        return refuse("the page's props end in a rest element")
      const lastElement = param.name.elements.at(-1)
      edits.push(
        lastElement === undefined
          ? { at: param.name.getStart(sf) + 1, text: " boundaries " }
          : { at: lastElement.getEnd(), text: ", boundaries" },
      )
    }
  } else return refuse("the page component's props are not a name or an object pattern")
  const type = param.type
  if (type !== undefined && ts.isTypeLiteralNode(type)) {
    const has = type.members.some(
      (member) => member.name !== undefined && propertyName(ts, member.name) === "boundaries",
    )
    if (!has) {
      const lastMember = type.members.at(-1)
      const member = "readonly boundaries?: BoundaryStates"
      if (lastMember === undefined) edits.push({ at: type.getStart(sf) + 1, text: ` ${member} ` })
      else if (ownLine(source, type.getEnd() - 1)) {
        const lineStart = source.lastIndexOf("\n", type.getEnd() - 2) + 1
        edits.push({
          at: lineStart,
          text: `${indentAt(source, lastMember.getStart(sf))}${member}\n`,
        })
      } else {
        const ends = source.slice(lastMember.getStart(sf), lastMember.getEnd()).trimEnd()
        edits.push({
          at: lastMember.getEnd(),
          text: ends.endsWith(";") || ends.endsWith(",") ? ` ${member}` : `; ${member}`,
        })
      }
      const typeImport = ensureImport(ts, sf, {
        module: "@nifrajs/web",
        name: "BoundaryStates",
        typeOnly: true,
      })
      if (typeImport !== undefined) imports.push(typeImport)
    }
  }

  const hole = `<Hole of={${ident}} state={${states}${accessOf(name)}} />`
  const replaces = definition.replaces
  if (replaces !== undefined) {
    const at = replaces.getStart(sf)
    edits.push({ at, remove: replaces.getEnd() - at, text: hole })
  } else {
    const closing = ts.isJsxElement(jsx) ? jsx.closingElement : jsx.closingFragment
    const at = closing.getStart(sf)
    edits.push({
      at,
      text: ownLine(source, at) ? `  ${hole}\n${indentAt(source, at)}` : hole,
    })
  }

  const lines = [`name: ${JSON.stringify(name)},`, ...definition.fields].flatMap((field) =>
    field.split("\n"),
  )
  const text = `const ${ident} = {\n${lines.map((line) => (line === "" ? "" : `  ${line}`)).join("\n")}\n} as const`
  if (boundaries !== undefined) {
    const list = boundaries.value
    if (list === undefined || !ts.isArrayLiteralExpression(list))
      return refuse("`boundaries` is not an array literal")
    const lastElement = list.elements.at(-1)
    edits.push(
      lastElement === undefined
        ? { at: list.getStart(sf) + 1, text: ident }
        : { at: lastElement.getEnd(), text: `, ${ident}` },
    )
    edits.push({ at: boundaries.statement.getFullStart(), text: `\n\n${text}` })
  } else {
    const anchor = sf.statements.find(
      (statement) =>
        (ts.isFunctionDeclaration(statement) &&
          hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) ||
        ts.isExportAssignment(statement),
    )
    if (anchor === undefined)
      return refuse("the page has no default export to place the hole above")
    edits.push({
      at: anchor.getFullStart(),
      text: `\n\n${text}\nexport const boundaries = [${ident}]`,
    })
  }
  for (const need of [{ module: ADAPTER[framework] ?? "", name: "Hole" }, ...definition.imports]) {
    const edit = ensureImport(ts, sf, need)
    if (edit !== undefined) imports.push(edit)
  }
  return { edits: [...imports, ...edits], names, ident }
}

/** The server component a `--server` hole shows: its React view renders on the server only. */
function componentStub(name: string): string {
  return `import { t } from "@nifrajs/schema"
import { defineServerComponent } from "@nifrajs/web/server-components"

/** Rendered on the server for each visitor; the browser gets its HTML, never this file. */
export const ${name} = defineServerComponent({
  input: t.object({ id: t.string() }),
  props: t.object({ title: t.string() }),
  // Refuse a visitor who may not see it: throw a Response such as 403.
  authorize() {},
  load: (_ctx, input) => ({ title: \`TODO: \${input.id}\` }),
  view: ({ props }) => <section>{props.title}</section>,
})
`
}

function snippetFor(
  framework: Framework,
  name: string,
  ident: string,
  options: HoleScaffoldOptions,
): string {
  const fields = [
    `name: ${JSON.stringify(name)},`,
    `mode: "${options.shared === true ? "shared" : "dynamic"}",`,
    ...(options.interactive === true ? ["interactive: true,"] : []),
    ...(options.timeout === undefined ? [] : [`timeout: ${options.timeout},`]),
  ]
  if (framework === "vue")
    return `<script lang="ts">
// Beside the page's other imports; a hole renders h() output.
import { Hole } from "@nifrajs/web-vue/ppr"
import { h } from "vue"

const ${ident} = {
${fields.map((line) => `  ${line}`).join("\n")}
  render: (data: { readonly text: string }) => h("p", data.text),
  fallback: h("p", "Loading"),
} as const
export const boundaries = [${ident}] // with any boundaries the page already has
</script>

<!-- In the template, where the hole renders (props from defineProps(["data", "boundaries"])): -->
<Hole :of="${ident}" :state="props.boundaries${accessOf(name)}" />`
  return `<script module>
  // Beside the page's other imports; Text is any component that renders the data.
  import Hole from "@nifrajs/web-svelte/hole"
  import { ui } from "@nifrajs/web-svelte/ppr"
  import Text from "../../frontend/Text.svelte"

  const ${ident} = {
${fields.map((line) => `    ${line}`).join("\n")}
    render: (data) => ui(Text, { text: data.text }),
  }
  export const boundaries = [${ident}] // with any boundaries the page already has
</script>

<!-- In the markup, where the hole renders (states from let { boundaries: states } = $props()): -->
<Hole of={${ident}} state={states${accessOf(name)}} />`
}

/** `routes/tea/[id].tsx` → `tea/[id]`, the id `createServerComponents({ holes })` keys by. */
const routeIdOf = (page: string): string => page.replace(/^routes\//, "").replace(/\.[^./]+$/, "")

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined
}

export function insideRoot(root: string, file: string): string {
  const base = resolve(root)
  const target = resolve(base, file)
  if (!target.startsWith(`${base}${sep}`))
    throw new Error(`refusing to write outside the app: ${file}`)
  return target
}

/** The page and backend half `route` names: a URL path such as `/tea/:id`, or the page file. */
export function holeRouteFiles(
  route: string,
  framework: Framework,
): { readonly page: string; readonly backend: string } {
  const page = /\.(tsx|jsx|vue|svelte)$/.test(route)
    ? route.startsWith("routes/")
      ? route
      : `routes/${route.replace(/^\/+/, "")}`
    : routePathToFile(route, pageExtension(framework))
  return { page, backend: backendFileOf(page) }
}

/** The project's TypeScript with `files` opened: TypeScript 7 parses only the files its session has. */
export async function routeTypeScript(
  root: string,
  files: readonly string[],
): Promise<ProjectTypeScriptLoad> {
  const { loadProjectTypeScript } = await import("./internal/typescript-import.ts")
  const base = resolve(root)
  return loadProjectTypeScript(root, undefined, {
    files,
    read: (file) => {
      const path = resolve(base, file)
      if (!path.startsWith(`${base}${sep}`)) return undefined
      try {
        return readFileSync(path, "utf8")
      } catch {
        return undefined
      }
    },
  })
}

/**
 * Add hole `name` to the route at `route` (a URL path such as `/tea/:id`, or its page file). Nothing is
 * written when `write` is false, or when any edit cannot be placed.
 */
export async function scaffoldHole(
  root: string,
  route: string,
  name: string,
  framework: Framework,
  options: HoleScaffoldOptions,
  ts: typeof TS,
  write = true,
): Promise<HoleScaffoldResult> {
  const { page, backend } = holeRouteFiles(route, framework)
  const result = (
    fields: Partial<HoleScaffoldResult> & { readonly ok: boolean },
  ): HoleScaffoldResult => ({
    page,
    backend,
    changed: [],
    snippets: [],
    next: [],
    ...fields,
  })
  const refuse = (reason: string) => result({ ok: false, reason })

  if (!HOLE_NAME.test(name))
    return refuse(
      `"${name}" is not a hole name: 1 to 32 lowercase letters, digits and single hyphens, starting with a letter`,
    )
  if (framework === "vanilla")
    return refuse("partial prerendering needs a framework adapter's Hole; a vanilla page has none")
  if (
    options.timeout !== undefined &&
    !(Number.isInteger(options.timeout) && options.timeout >= 1 && options.timeout <= 30000)
  )
    return refuse("--timeout is a whole number of milliseconds from 1 to 30000")
  if (options.server === true && (options.shared === true || options.interactive === true))
    return refuse("a hole that shows a server component is dynamic and not interactive")
  // Another adapter's server view is a native component in a file of its own, which the scaffold
  // cannot write for it.
  if (options.server === true && framework !== "react")
    return refuse(
      "--server writes a React server component; for this adapter, define the component with nativeServerView first (see the server components docs), then render it with serverHole(Component)",
    )

  const backendPath = insideRoot(root, backend)
  const pagePath = insideRoot(root, page)
  if (!(await exists(pagePath))) return refuse(`no page at ${page}`)
  if (!(await exists(backendPath)))
    return refuse(
      `${page} is not partially prerendered: it has no backend half. Add ${backend} with \`export const shellLoader\` and \`shellOutput\` first (see the partial prerendering docs)`,
    )
  const backendSource = await readFile(backendPath, "utf8")
  const backendFile = ts.createSourceFile(
    backend,
    backendSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  if (!exportsName(ts, backendFile, "shellLoader"))
    return refuse(
      `${page} is not partially prerendered: ${backend} exports no \`shellLoader\`. Add it, with \`shellOutput\`, first (see the partial prerendering docs)`,
    )
  const back = backendPlan(ts, backendFile, name, scaffoldLoader(options))
  if (back.reason !== undefined) return refuse(`${backend}: ${back.reason}`)
  if (back.keys.includes(name)) return refuse(`${backend} already has a loader for "${name}"`)
  if (back.keys.length >= MAX_HOLES)
    return refuse(
      `${backend} already has ${back.keys.length} hole loaders, the most a route may have`,
    )

  const component =
    options.server === true
      ? {
          name: pascal(name),
          file: `components/${pascal(name)}.component.server.tsx`,
        }
      : undefined
  const specifier =
    component === undefined
      ? undefined
      : (() => {
          const rel = relative(dirname(pagePath), resolve(root, component.file))
            .split(sep)
            .join("/")
          return rel.startsWith(".") ? rel : `./${rel}`
        })()

  const snippets: { file: string; code: string }[] = []
  const writes: { file: string; path: string; text: string; create?: true }[] = []
  if (ADAPTER[framework] !== undefined) {
    const pageSource = await readFile(pagePath, "utf8")
    const pageFile = ts.createSourceFile(
      page,
      pageSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )
    const front = pagePlan(
      ts,
      pageFile,
      name,
      framework,
      scaffoldDefinition(
        framework,
        options,
        component === undefined || specifier === undefined
          ? undefined
          : { name: component.name, specifier },
      ),
    )
    if (front.reason !== undefined) return refuse(`${page}: ${front.reason}`)
    if (front.names.includes(name))
      return refuse(`${page} already declares a boundary named "${name}"`)
    writes.push({ file: page, path: pagePath, text: apply(pageSource, front.edits) })
  } else {
    snippets.push({ file: page, code: snippetFor(framework, name, camel(name), options) })
  }
  writes.push({ file: backend, path: backendPath, text: apply(backendSource, back.edits) })
  if (component !== undefined) {
    const path = insideRoot(root, component.file)
    if (await exists(path)) return refuse(`${component.file} already exists`)
    writes.push({ file: component.file, path, text: componentStub(component.name), create: true })
  }

  const next: string[] = []
  if (component !== undefined) {
    next.push(
      `List ${component.name} for this route in the server entry: createServerComponents({ holes: { ${JSON.stringify(routeIdOf(page))}: { components: [${component.name}] } } }).`,
      "Call holeComponents() with the adapter's component client in the client entry, before the router mounts.",
      "Build with the coordinated compiler (buildServerComponents).",
    )
  }
  if (snippets.length > 0) next.push(`Place the hole in ${page} from the snippet.`)
  next.push(
    `Replace the TODO loader in ${backend}, and its output schema with what the hole renders.`,
  )

  if (!write)
    return result({
      ok: true,
      snippets,
      next,
      preview: writes.map((entry) => ({ file: entry.file, text: entry.text })),
    })
  for (const entry of writes) {
    if (entry.create === true) {
      await mkdir(dirname(entry.path), { recursive: true })
      await writeFile(entry.path, entry.text, { flag: "wx" })
    } else await writeFile(entry.path, entry.text, "utf8")
  }
  // The page's `./+types` module now names the new hole, so `Route.BoundaryLoaders` checks its key.
  const { refreshRouteTypes } = await import("./route-types.ts")
  refreshRouteTypes(root, () => {})
  return result({ ok: true, changed: writes.map((entry) => entry.file), snippets, next })
}

/** The MCP tool's answer: what was written or would be, and what is left. */
export function renderHoleScaffold(
  name: string,
  framework: Framework,
  out: HoleScaffoldResult,
): string {
  const head = `# Scaffold hole \`${name}\` on \`${out.page}\` (${framework})`
  if (!out.ok) return `${head}\n\nNot scaffolded: ${out.reason ?? "unknown reason"}`
  const status =
    out.preview === undefined
      ? `**Written:** ${out.changed.map((file) => `\`${file}\``).join(", ")}`
      : "**Dry run:** pass `write: true` to apply these files."
  const previews = (out.preview ?? []).map(
    (entry) => `\n\n\`${entry.file}\`:\n\n\`\`\`tsx\n${entry.text}\`\`\``,
  )
  const snippets = out.snippets.map(
    (snippet) =>
      `\n\nPaste into \`${snippet.file}\`:\n\n\`\`\`${framework}\n${snippet.code}\n\`\`\``,
  )
  const next = out.next.map((step) => `- ${step}`).join("\n")
  return `${head}\n\n${status}${previews.join("")}${snippets.join("")}\n\n**Next:**\n${next}`
}
