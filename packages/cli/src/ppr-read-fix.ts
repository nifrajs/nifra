/**
 * `nifra fix --code NF-C053`: move a partially prerendered page's request read into a dynamic hole.
 * The read must be held in one `const` of the page component's body, and every use of it must sit in
 * one element of the markup the component returns. That element becomes the hole's render, reading
 * the value from the hole's data, and the read becomes the hole's loader in the backend half, with an
 * output schema drafted from its type. Anything else is refused with the reason, and nothing is
 * written.
 */
import { readFile, writeFile } from "node:fs/promises"
import type * as TS from "typescript"
import { holeLoaderShape, omittedPaths, type Shape, schemaSource } from "./output-schemas.ts"
import { lineOf } from "./rules/islands.ts"
import { REQUEST_READ_MODULE, requestReadCalls, requestReadImports } from "./rules/ppr.ts"
import type { Framework } from "./scaffold.ts"
import { backendFileOf } from "./scaffold.ts"
import {
  ADAPTER,
  apply,
  backendPlan,
  defaultComponent,
  type Edit,
  fallbackField,
  HOLE_NAME,
  type ImportNeed,
  indentAt,
  insideRoot,
  localNames,
  MAX_HOLES,
  pagePlan,
  returnedJsx,
  topLevelNames,
} from "./scaffold-hole.ts"

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** The TypeScript type `shape` describes, or undefined for one the hole's data cannot carry. */
function typeText(shape: Shape): string | undefined {
  switch (shape.kind) {
    case "string":
    case "number":
    case "boolean":
    case "null":
      return shape.kind
    case "literal":
      return JSON.stringify(shape.value)
    case "array":
    case "tuple": {
      const items = shape.kind === "array" ? [shape.items] : shape.items
      const types = items.map(typeText)
      return types.some((type) => type === undefined)
        ? undefined
        : `readonly (${[...new Set(types)].join(" | ")})[]`
    }
    case "record": {
      const values = typeText(shape.values)
      return values === undefined ? undefined : `Readonly<Record<string, ${values}>>`
    }
    case "union": {
      const types = shape.members.map(typeText)
      return types.some((type) => type === undefined) ? undefined : types.join(" | ")
    }
    case "object": {
      const fields: string[] = []
      for (const field of shape.fields) {
        const type = typeText(field.shape)
        if (type === undefined) return undefined
        const key = IDENTIFIER.test(field.name) ? field.name : JSON.stringify(field.name)
        fields.push(`readonly ${key}${field.optional ? "?" : ""}: ${type}`)
      }
      return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`
    }
    default:
      return undefined
  }
}

/** Whether `id` reads a binding: not a property name, a declared name or an intrinsic tag. */
function isReference(ts: typeof TS, id: TS.Identifier): boolean {
  const parent = id.parent
  if (parent === undefined || ts.isImportSpecifier(parent) || ts.isImportClause(parent))
    return false
  if (ts.isShorthandPropertyAssignment(parent)) return true
  // A declaration's, property's or attribute's own name binds or labels; it reads nothing. Read by
  // field, since TypeScript 7's API lacks some of the guards (`isPropertySignature`).
  if ("name" in parent && parent.name === id) return false
  if (ts.isQualifiedName(parent)) return parent.left === id
  if (ts.isBindingElement(parent)) return parent.propertyName !== id
  if (
    ts.isJsxOpeningElement(parent) ||
    ts.isJsxSelfClosingElement(parent) ||
    ts.isJsxClosingElement(parent)
  )
    return !/^[a-z]/.test(id.text)
  return true
}

/** Every identifier under `node` that reads a binding. */
function references(ts: typeof TS, node: TS.Node): TS.Identifier[] {
  const found: TS.Identifier[] = []
  const visit = (at: TS.Node): void => {
    if (ts.isIdentifier(at) && isReference(ts, at)) found.push(at)
    ts.forEachChild(at, visit)
  }
  visit(node)
  return found
}

/** Each name `node` declares, as often as it declares it. */
function declarations(ts: typeof TS, node: TS.Node): string[] {
  const names: string[] = []
  const visit = (at: TS.Node): void => {
    if (
      (ts.isVariableDeclaration(at) ||
        ts.isParameter(at) ||
        ts.isBindingElement(at) ||
        ts.isFunctionDeclaration(at)) &&
      at.name !== undefined &&
      ts.isIdentifier(at.name)
    )
      names.push(at.name.text)
    ts.forEachChild(at, visit)
  }
  visit(node)
  return names
}

const within = (sf: TS.SourceFile, outer: TS.Node, inner: TS.Node): boolean =>
  outer.getStart(sf) <= inner.getStart(sf) && inner.getEnd() <= outer.getEnd()

/** `text`, its lines after the first moved from `from` indentation to `to`. */
function reindent(text: string, from: string, to: string): string {
  return text
    .split("\n")
    .map((line, i) =>
      i === 0 ? line : `${to}${line.startsWith(from) ? line.slice(from.length) : line.trimStart()}`,
    )
    .join("\n")
}

/** `visitorName` → `visitor-name`, or undefined when no hole name comes of it. */
function holeNameOf(local: string): string | undefined {
  const name = local
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|(?<!-)-+$/g, "")
    .slice(0, 28)
    .replace(/(?<!-)-+$/, "")
  return HOLE_NAME.test(name) ? name : undefined
}

/**
 * Move the request read `diagnostic` found at `line` of the page `file` (relative to `root`) into a new
 * dynamic hole. Returns the files it wrote; throws with the reason when it cannot, writing nothing.
 */
export async function moveReadToHole(
  root: string,
  file: string,
  line: number | undefined,
  framework: Framework,
  ts: typeof TS,
): Promise<readonly string[]> {
  const refuse = (reason: string): never => {
    throw new Error(`[nifra] ${file}: ${reason}; nothing was changed`)
  }
  const adapter = ADAPTER[framework]
  if (adapter === undefined)
    return refuse(
      `the fix writes a JSX hole, and a ${framework} page renders none; move the read by hand (nifra scaffold hole prints the hole to start from)`,
    )
  if (!/\.[jt]sx$/.test(file)) return refuse("the fix edits a .tsx or .jsx page only")
  const backend = backendFileOf(file)
  const pagePath = insideRoot(root, file)
  const backendPath = insideRoot(root, backend)
  const pageSource = await readFile(pagePath, "utf8")
  const backendSource = await readFile(backendPath, "utf8")
  const sf = ts.createSourceFile(file, pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const backendFile = ts.createSourceFile(
    backend,
    backendSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )

  const reads = requestReadImports(ts, sf)
  const call = requestReadCalls(ts, sf, reads).find((found) => lineOf(sf, found) === line)
  if (call === undefined)
    return refuse(
      `no request read is at line ${line ?? "?"} any more; rerun \`nifra fix --code NF-C053\``,
    )
  const page = defaultComponent(ts, sf)
  const body = page?.body
  if (page === undefined || body === undefined || !ts.isBlock(body))
    return refuse("the read is not in the body of the page's default-exported component")
  let statement: TS.Node = call
  while (statement.parent !== body) {
    if (statement.parent === undefined || statement.parent === sf)
      return refuse("the read is not in a statement of the page component's own body")
    statement = statement.parent
  }
  const declaration = ts.isVariableStatement(statement)
    ? statement.declarationList.declarations[0]
    : undefined
  if (
    !ts.isVariableStatement(statement) ||
    !/^const\s/.test(statement.declarationList.getText(sf)) ||
    statement.declarationList.declarations.length !== 1 ||
    declaration === undefined ||
    !ts.isIdentifier(declaration.name) ||
    declaration.initializer === undefined
  )
    return refuse("the read is not held in one `const <name> = ...` of the page component")
  const local = declaration.name.text
  const initializer = declaration.initializer

  // The loader sees module scope in the backend half: globals and the request reads, not the page's
  // own names or the component's.
  const pageNames = topLevelNames(ts, sf)
  const componentNames = new Set<string>()
  localNames(ts, page, componentNames)
  const ownNames = new Set(declarations(ts, initializer))
  for (const id of references(ts, initializer)) {
    if (reads.has(id.text) || ownNames.has(id.text)) continue
    if (componentNames.has(id.text) || pageNames.has(id.text))
      return refuse(
        `the read uses \`${id.text}\`, which the page defines or imports, and a hole's loader runs in the backend half without it`,
      )
  }

  if (declarations(ts, page).filter((name) => name === local).length > 1)
    return refuse(`\`${local}\` is declared more than once in the page component`)
  const uses = references(ts, body).filter((id) => id.text === local && !within(sf, statement, id))
  if (uses.length === 0) return refuse(`\`${local}\` is not used in the page's markup`)
  const jsx = returnedJsx(ts, page)
  if (jsx === undefined)
    return refuse("the page component does not return one JSX element the hole can go inside")
  const outside = uses.find((use) => !within(sf, jsx, use))
  if (outside !== undefined)
    return refuse(
      `\`${local}\` is also used outside the markup the page returns (line ${lineOf(sf, outside)}), and only markup moves into a hole`,
    )

  // The element the hole takes the place of: the innermost one holding every use.
  const elementOf = (node: TS.Node): TS.Node | undefined => {
    for (let at = node.parent; at !== undefined; at = at.parent)
      if (ts.isJsxElement(at) || ts.isJsxSelfClosingElement(at) || ts.isJsxFragment(at)) return at
    return undefined
  }
  const holdsAll = (node: TS.Node): boolean => uses.every((use) => within(sf, node, use))
  const [first] = uses
  let target = first === undefined ? undefined : elementOf(first)
  while (target !== undefined && !holdsAll(target)) target = elementOf(target)
  if (target === undefined || target === jsx)
    return refuse(
      `the uses of \`${local}\` span the page's root element; wrap them in one element, then rerun the fix`,
    )
  const subtree = target
  for (const id of references(ts, subtree)) {
    if (id.text === local) continue
    if (componentNames.has(id.text))
      return refuse(
        `the markup that uses \`${local}\` also uses \`${id.text}\`, which the page component declares, and a hole renders from its loader's data alone`,
      )
    if (reads.has(id.text))
      return refuse(`the markup that uses \`${local}\` reads the request itself`)
  }
  const interactive = (() => {
    let found = false
    const visit = (node: TS.Node): void => {
      if (ts.isJsxAttribute(node) && /^on[A-Z]/.test(node.name.getText(sf))) found = true
      if (!found) ts.forEachChild(node, visit)
    }
    visit(subtree)
    return found
  })()

  // The hole's name, unused by the page's boundaries and the backend half's loaders.
  const base = holeNameOf(local) ?? "request"
  const usedNames = (name: string): readonly string[] => [
    ...pagePlan(ts, sf, name, framework, { fields: [], imports: [] }).names,
    ...backendPlan(ts, backendFile, name, { body: [], imports: [] }).keys,
  ]
  let name = base
  for (let n = 2; usedNames(name).includes(name); n++) name = `${base}-${n}`
  const loaderKeys = backendPlan(ts, backendFile, name, { body: [], imports: [] }).keys
  if (loaderKeys.length >= MAX_HOLES)
    return refuse(
      `${backend} already has ${loaderKeys.length} hole loaders, the most a route may have`,
    )

  const readImports: ImportNeed[] = []
  const backendNames = topLevelNames(ts, backendFile)
  const backendReads = requestReadImports(ts, backendFile)
  const readsUsed = new Set(references(ts, initializer).map((id) => id.text))
  for (const [binding, imported] of reads) {
    if (!readsUsed.has(binding)) continue
    if (backendNames.has(binding) && backendReads.get(binding) !== imported)
      return refuse(`${backend} already declares \`${binding}\``)
    readImports.push({ module: REQUEST_READ_MODULE, name: binding, imported })
  }
  const statementIndent = indentAt(pageSource, statement.getStart(sf))
  const read = reindent(initializer.getText(sf), statementIndent, "")
  const loader = (output: string) => ({
    body: [
      "// Read for each visitor, under the hole's own deadline; the shell never sees it.",
      ...`load: () => ({ ${local}: ${read} }),`.split("\n"),
      ...`output: ${output},`.split("\n"),
    ],
    imports: [{ module: "@nifrajs/schema", name: "t" }, ...readImports],
  })
  const probe = backendPlan(ts, backendFile, name, loader("t.json()"))
  if (probe.reason !== undefined) return refuse(`${backend}: ${probe.reason}`)
  const { shape, warnings } = await holeLoaderShape(
    root,
    backend,
    name,
    apply(backendSource, probe.edits),
  )
  if (warnings.length > 0)
    return refuse(`the read's type could not be read: ${warnings.join("; ")}`)
  const field =
    shape?.kind === "object" ? shape.fields.find((entry) => entry.name === local) : undefined
  const data: Shape | undefined =
    field === undefined ? undefined : { kind: "object", fields: [field] }
  const dataType = data === undefined ? undefined : typeText(data)
  if (data === undefined || dataType === undefined || omittedPaths(data).length > 0)
    return refuse(
      `the read's value is not a type the fix can describe with a schema (strings, numbers, booleans, null, and arrays and objects of them); move it by hand`,
    )
  const back = backendPlan(ts, backendFile, name, loader(schemaSource(data)))
  if (back.reason !== undefined) return refuse(`${backend}: ${back.reason}`)

  // The render reads the value from the hole's data, under a parameter name the markup leaves free.
  const subtreeNames = new Set(references(ts, subtree).map((id) => id.text))
  const param = ["data", "hole", "holeData"].find((candidate) => !subtreeNames.has(candidate))
  if (param === undefined) return refuse("the markup uses every name the fix would give the data")
  const start = subtree.getStart(sf)
  const renames: Edit[] = uses.map((use) =>
    use.parent !== undefined && ts.isShorthandPropertyAssignment(use.parent)
      ? {
          at: use.getStart(sf) - start,
          remove: use.getWidth(sf),
          text: `${local}: ${param}.${local}`,
        }
      : { at: use.getStart(sf) - start, remove: use.getWidth(sf), text: `${param}.${local}` },
  )
  const markup = reindent(apply(subtree.getText(sf), renames), indentAt(pageSource, start), "  ")
  const signature = `render: (${param}: ${dataType}) =>`
  const render =
    markup.includes("\n") || signature.length + markup.length > 90
      ? `${signature} (\n  ${markup}\n),`
      : `${signature} ${markup},`
  const front = pagePlan(ts, sf, name, framework, {
    fields: [
      'mode: "dynamic",',
      ...(interactive ? ["interactive: true, // its event handlers hydrate with the hole"] : []),
      render,
      fallbackField(framework),
    ],
    imports: [],
    replaces: subtree,
  })
  if (front.reason !== undefined) return refuse(front.reason)

  // The read's statement goes, with its line when it has one to itself.
  const lineStart = pageSource.lastIndexOf("\n", statement.getStart(sf) - 1) + 1
  const lineEnd = pageSource.indexOf("\n", statement.getEnd())
  const ownLines =
    pageSource.slice(lineStart, statement.getStart(sf)).trim() === "" &&
    pageSource.slice(statement.getEnd(), lineEnd === -1 ? undefined : lineEnd).trim() === ""
  const edits: Edit[] = [
    ...front.edits,
    ownLines
      ? {
          at: lineStart,
          remove: (lineEnd === -1 ? pageSource.length : lineEnd + 1) - lineStart,
          text: "",
        }
      : { at: statement.getStart(sf), remove: statement.getWidth(sf), text: "" },
  ]
  // A read import nothing else in the page uses goes too.
  const stillUsed = new Set(
    references(ts, sf)
      .filter((id) => reads.has(id.text) && !within(sf, statement, id))
      .map((id) => id.text),
  )
  for (const imported of sf.statements) {
    if (
      !ts.isImportDeclaration(imported) ||
      !ts.isStringLiteral(imported.moduleSpecifier) ||
      imported.moduleSpecifier.text !== REQUEST_READ_MODULE
    )
      continue
    const clause = imported.importClause
    const bindings = clause?.namedBindings
    if (clause === undefined || bindings === undefined || !ts.isNamedImports(bindings)) continue
    const kept = bindings.elements.filter(
      (element) => !reads.has(element.name.text) || stillUsed.has(element.name.text),
    )
    if (kept.length === bindings.elements.length) continue
    if (kept.length === 0 && clause.name === undefined) {
      // From the line break before it: a new import may be placed right where this one ends.
      const start = imported.getStart(sf)
      const from = start > 0 && pageSource[start - 1] === "\n" ? start - 1 : start
      edits.push({ at: from, remove: imported.getEnd() - from, text: "" })
    } else
      edits.push({
        at: bindings.getStart(sf),
        remove: bindings.getWidth(sf),
        text: `{ ${kept.map((element) => element.getText(sf)).join(", ")} }`,
      })
  }

  const fixed = apply(pageSource, edits)
  // An import removed from the very top leaves the line break that followed it.
  await writeFile(
    pagePath,
    fixed.startsWith("\n") && !pageSource.startsWith("\n") ? fixed.slice(1) : fixed,
    "utf8",
  )
  await writeFile(backendPath, apply(backendSource, back.edits), "utf8")
  const { refreshRouteTypes } = await import("./route-types.ts")
  refreshRouteTypes(root, () => {})
  return [file, backend]
}
