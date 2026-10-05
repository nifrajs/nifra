import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { compileComponentModule, sourceFile } from "@nifrajs/web/server-components/source"
import ts from "typescript"
import type { SourceIndex } from "./rules/index.ts"

function literal(node: ts.Expression): unknown {
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  )
    return literal(node.expression)
  if (ts.isStringLiteral(node)) return node.text
  if (!ts.isObjectLiteralExpression(node)) throw new Error("component_pipeline_literal")
  const result: Record<string, unknown> = Object.create(null)
  for (const member of node.properties) {
    if (
      !ts.isPropertyAssignment(member) ||
      !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
    )
      throw new Error("component_pipeline_literal")
    if (
      Object.hasOwn(result, member.name.text) ||
      ["__proto__", "prototype", "constructor"].includes(member.name.text)
    )
      throw new Error("component_pipeline_literal")
    result[member.name.text] = literal(member.initializer)
  }
  return result
}

/** A source-only proof. nifra check never executes nifra.config.ts. */
export function componentCheckReceipts(root: string, source: SourceIndex): ReadonlySet<string> {
  const receipts = new Set<string>()
  const configFile = ["nifra.config.ts", "backend/framework.ts"].find((file) =>
    existsSync(resolve(root, file)),
  )
  if (configFile === undefined) return receipts
  const config = sourceFile(readFileSync(resolve(root, configFile), "utf8"), configFile)
  let pipeline: unknown
  for (const statement of config.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue
    for (const variable of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(variable.name) ||
        variable.name.text !== "componentPipeline" ||
        variable.initializer === undefined
      )
        continue
      try {
        pipeline = literal(variable.initializer)
      } catch {
        return receipts
      }
    }
  }
  if (typeof pipeline !== "object" || pipeline === null || Array.isArray(pipeline)) return receipts
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Static receipt inspection checks object shape before reading fields; the source scanner never executes configuration.
  const options = pipeline as Record<string, unknown>
  if (
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Static receipt inspection checks object shape before reading fields; the source scanner never executes configuration.
    !["react", "vue", "svelte", "solid"].includes(options.adapter as string) ||
    typeof options.entries !== "object" ||
    options.entries === null ||
    Array.isArray(options.entries)
  )
    return receipts
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Static receipt inspection checks object shape before reading fields; the source scanner never executes configuration.
  const entries = options.entries as Record<string, unknown>
  if (
    typeof entries.client !== "string" ||
    typeof entries.ssr !== "string" ||
    (options.adapter === "react" && typeof entries.rsc !== "string") ||
    Object.values(entries).some(
      (file) => typeof file !== "string" || !existsSync(resolve(root, file)),
    )
  )
    return receipts
  for (const file of source.files) {
    if (!/\.component\.server\.[cm]?[jt]sx?$/.test(file)) continue
    const content = source.read(file)
    if (content === undefined) continue
    try {
      compileComponentModule(content, resolve(root, file), root, "client")
      receipts.add(file)
      receipts.add(resolve(root, file))
    } catch {
      /* A module without a compilation receipt remains forbidden by the ordinary import rule. */
    }
  }
  return receipts
}
