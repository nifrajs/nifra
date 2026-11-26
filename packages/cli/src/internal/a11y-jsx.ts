import type * as TSApi from "typescript"
import {
  type A11yFinding,
  type AttributeValue,
  type ElementAttribute,
  judgeElement,
} from "./a11y-element.ts"
import type { TypeScriptApi } from "./typescript-import.ts"

export type { A11yCode, A11yFinding, A11yKind } from "./a11y-element.ts"

/**
 * The accessibility findings in the JSX of `source`: React, Preact and Solid all write the same
 * intrinsic elements. Only a lowercase intrinsic element is judged, and only from what its attributes
 * spell out: an element with a spread is left alone, since the spread may supply or replace any of
 * them, and a value written as an expression is never read.
 */
export function a11yFindings(ts: TypeScriptApi, source: TSApi.SourceFile): readonly A11yFinding[] {
  const found: A11yFinding[] = []

  const attributeValue = (attribute: TSApi.JsxAttribute): AttributeValue => {
    const init = attribute.initializer
    if (init === undefined) return { kind: "other" }
    if (ts.isStringLiteral(init)) return { kind: "text", text: init.text }
    if (ts.isJsxExpression(init) && init.expression !== undefined) {
      const expression = init.expression
      if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression))
        return { kind: "text", text: expression.text }
    }
    return { kind: "other" }
  }

  const inspect = (node: TSApi.JsxOpeningElement | TSApi.JsxSelfClosingElement): void => {
    const tagName = node.tagName
    if (!ts.isIdentifier(tagName) || !/^[a-z][a-z0-9]*$/.test(tagName.text)) return
    const attributes = new Map<string, ElementAttribute>()
    for (const property of node.attributes.properties) {
      if (ts.isJsxSpreadAttribute(property)) return
      if (!ts.isIdentifier(property.name)) continue
      attributes.set(property.name.text.toLowerCase(), {
        at: property.getStart(source),
        value: attributeValue(property),
      })
    }
    found.push(...judgeElement(tagName.text, attributes, node.getStart(source)))
  }

  const visit = (node: TSApi.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) inspect(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found.sort((a, b) => a.position - b.position)
}
