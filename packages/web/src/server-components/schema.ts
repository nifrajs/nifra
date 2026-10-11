import type { StandardSchemaV1 } from "@nifrajs/core/server"
import { jsonSchemaOf } from "../internal/output-guard.ts"
import { ServerComponentError } from "./error.ts"

export { componentValue } from "./value.ts"

const forbidden = new Set(["__proto__", "prototype", "constructor"])
const scalar = new Set(["string", "number", "integer", "boolean", "null"])

export function assertComponentSchema(schema: StandardSchemaV1): void {
  const root = jsonSchemaOf(schema)
  if (root === undefined) throw new ServerComponentError("component_contract")
  const visiting = new Set<object>()
  const checked = new Set<object>()
  const visit = (value: unknown, depth: number): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value) || depth > 32) {
      throw new ServerComponentError("component_contract")
    }
    if (visiting.has(value)) throw new ServerComponentError("component_contract")
    if (checked.has(value)) return
    visiting.add(value)
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Schema traversal verifies object shape and local references before inspecting schema members.
    const node = value as Record<string, unknown>
    if (node.$ref !== undefined) {
      if (typeof node.$ref !== "string" || !node.$ref.startsWith("#/"))
        throw new ServerComponentError("component_contract")
      let target: unknown = root
      for (const part of node.$ref.slice(2).split("/")) {
        const name = part.replace(/~1/g, "/").replace(/~0/g, "~")
        if (
          forbidden.has(name) ||
          typeof target !== "object" ||
          target === null ||
          !Object.hasOwn(target, name)
        ) {
          throw new ServerComponentError("component_contract")
        }
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Schema traversal verifies object shape and local references before inspecting schema members.
        target = (target as Record<string, unknown>)[name]
      }
      visit(target, depth + 1)
    } else if (node.anyOf !== undefined || node.oneOf !== undefined || node.allOf !== undefined) {
      for (const name of ["anyOf", "oneOf", "allOf"]) {
        if (node[name] === undefined) continue
        if (!Array.isArray(node[name]) || node[name].length === 0)
          throw new ServerComponentError("component_contract")
        for (const child of node[name]) visit(child, depth + 1)
      }
    } else if (node.type === "object") {
      if (node.additionalProperties !== false || node.patternProperties !== undefined)
        throw new ServerComponentError("component_contract")
      const properties = node.properties
      if (typeof properties !== "object" || properties === null || Array.isArray(properties))
        throw new ServerComponentError("component_contract")
      for (const [name, child] of Object.entries(properties)) {
        if (forbidden.has(name)) throw new ServerComponentError("component_contract")
        visit(child, depth + 1)
      }
    } else if (node.type === "array") {
      if (Array.isArray(node.items)) for (const child of node.items) visit(child, depth + 1)
      else visit(node.items, depth + 1)
    } else if (typeof node.type !== "string" || !scalar.has(node.type)) {
      throw new ServerComponentError("component_contract")
    }
    visiting.delete(value)
    checked.add(value)
  }
  visit(root, 0)
}
