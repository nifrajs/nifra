import { basename } from "node:path"
import { toOpenAPI } from "@nifrajs/schema/openapi"
import type { LoadedApp } from "./load.ts"

export type OpenApiFormat = "json" | "yaml"

function hasRoutesMethod(value: unknown): value is Parameters<typeof toOpenAPI>[0] {
  return typeof (value as { routes?: unknown } | undefined)?.routes === "function"
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces)
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : `${pad}${line}`))
    .join("\n")
}

function toYaml(value: unknown, depth = 0): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    return value
      .map((item) => {
        if (item !== null && typeof item === "object")
          return `-\n${indent(toYaml(item, depth + 1), 2)}`
        return `- ${toYaml(item, depth + 1)}`
      })
      .join("\n")
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return "{}"
  return entries
    .map(([key, item]) => {
      const rendered = toYaml(item, depth + 1)
      if (item !== null && typeof item === "object" && rendered !== "{}" && rendered !== "[]") {
        return `${JSON.stringify(key)}:\n${indent(rendered, 2)}`
      }
      return `${JSON.stringify(key)}: ${rendered}`
    })
    .join("\n")
}

/** Render a project's backend as OpenAPI 3.1. Frontend-only apps get a valid empty document, which is
 * easier for agents and API tooling to handle than a tool error. */
export function renderOpenApi(app: LoadedApp, format: OpenApiFormat): string {
  const title = `${basename(app.cwd)} API`
  const input = hasRoutesMethod(app.backend) ? app.backend : {}
  const document = toOpenAPI(input, { title, version: "1.0.0" })
  return format === "yaml" ? toYaml(document) : JSON.stringify(document, null, 2)
}
