const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** A `t`/Standard Schema exposing its raw JSON Schema → that JSON Schema; anything else → undefined. */
function jsonSchemaOf(schema: unknown): unknown {
  return schema && typeof schema === "object" && "jsonSchema" in schema
    ? (schema as { readonly jsonSchema: unknown }).jsonSchema
    : undefined
}

/** The subset of JSON Schema fields {@link tsTypeOf} reads to render a TypeScript type string. */
interface JsonSchemaNode {
  readonly type?: string
  readonly anyOf?: readonly unknown[]
  readonly oneOf?: readonly unknown[]
  readonly enum?: readonly unknown[]
  readonly const?: unknown
  readonly items?: unknown
  readonly properties?: Readonly<Record<string, unknown>>
  readonly required?: readonly string[]
  readonly additionalProperties?: unknown
}

function tsTypeOf(schema: unknown, depth = 0): string {
  if (typeof schema !== "object" || schema === null || depth > 6) return JSON.stringify(schema)
  const node = schema as JsonSchemaNode
  const union = node.anyOf ?? node.oneOf
  if (Array.isArray(union)) return union.map((u) => tsTypeOf(u, depth + 1)).join(" | ")
  if (Array.isArray(node.enum)) return node.enum.map((v) => JSON.stringify(v)).join(" | ")
  if (node.const !== undefined) return JSON.stringify(node.const)
  switch (node.type) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
    case "array": {
      const item = tsTypeOf(node.items, depth + 1)
      return item.includes(" | ") ? `(${item})[]` : `${item}[]`
    }
    case "object": {
      const props = node.properties
      if (props === undefined) {
        return node.additionalProperties === undefined || node.additionalProperties === false
          ? "{}"
          : `Record<string, ${node.additionalProperties === true ? "unknown" : tsTypeOf(node.additionalProperties, depth + 1)}>`
      }
      const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : [])
      const fields = Object.entries(props).map(
        ([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${tsTypeOf(value, depth + 1)}`,
      )
      return `{ ${fields.join(", ")} }`
    }
    default:
      return JSON.stringify(schema)
  }
}

function clientCall(method: string, path: string, schema: unknown): string {
  const s = schema as { body?: unknown; query?: unknown } | undefined
  const verb = method.toLowerCase()
  const segs = path.split("/").filter((seg) => seg !== "")
  let chain = "api"
  if (segs.length === 0) chain += ".index"
  else
    for (const seg of segs) {
      if (seg.startsWith(":") || seg.startsWith("*")) {
        const name = seg.replace(/^[:*]/, "") || "value"
        chain += `({ ${name} })`
      } else chain += IDENT.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`
    }
  const isBodyVerb = verb === "post" || verb === "put" || verb === "patch"
  let call: string
  if (isBodyVerb) {
    const bodyArg = s?.body ? "body" : s?.query ? "undefined" : ""
    const opts = s?.query ? (bodyArg ? ", { query }" : "{ query }") : ""
    call = `.${verb}(${bodyArg}${opts})`
  } else {
    call = `.${verb}(${s?.query ? "{ query }" : ""})`
  }
  return `await ${chain}${call}`
}

export async function generateLlmsTxt(
  full: boolean,
  pageRoutes: ReadonlyArray<{ readonly pattern: string; readonly id: string }>,
  backend: unknown,
): Promise<string> {
  let output = ""
  output += `# Nifra App Context\n\n`
  output += `This is a machine-readable context endpoint describing the API routes, pages, and conventions of this Nifra application.\n\n`

  // 1. Project Guidelines
  let agentsMd = ""
  try {
    if (typeof Bun !== "undefined") {
      agentsMd = await Bun.file("AGENTS.md").text()
    } else {
      const fs = await import("node:fs/promises")
      agentsMd = await fs.readFile("AGENTS.md", "utf-8")
    }
  } catch {
    // ignore
  }

  if (agentsMd) {
    output += `## Guidelines & Conventions\n\n`
    output += `${agentsMd}\n\n`
  }

  // 2. Page Routes
  output += `## Page Routes\n\n`
  for (const page of pageRoutes) {
    output += `- Page \`${page.pattern}\` (route ID: \`${page.id}\`)\n`
  }
  output += `\n`

  // 3. API Routes
  output += `## API Routes\n\n`
  const backendWithRoutes = backend as { readonly routes?: () => unknown } | null
  let apiRoutes: Array<{ method: string; path: string; schema?: unknown }> = []
  if (backendWithRoutes && typeof backendWithRoutes.routes === "function") {
    try {
      apiRoutes = (backendWithRoutes.routes() as typeof apiRoutes) ?? []
    } catch {
      // ignore
    }
  }

  if (apiRoutes.length === 0) {
    output += `No API routes registered.\n`
  } else {
    for (const route of apiRoutes) {
      output += `- **${route.method}** \`${route.path}\`\n`
      if (full) {
        output += `  - Client Call: \`${clientCall(route.method, route.path, route.schema)}\`\n`
        const s = route.schema as
          | {
              body?: unknown
              query?: unknown
              response?: unknown
              errors?: Record<string, unknown>
            }
          | undefined
        const bodySchema = jsonSchemaOf(s?.body)
        const querySchema = jsonSchemaOf(s?.query)
        const responseSchema = jsonSchemaOf(s?.response)

        if (bodySchema) {
          output += `  - Body Schema: \`${tsTypeOf(bodySchema)}\`\n`
        }
        if (querySchema) {
          output += `  - Query Schema: \`${tsTypeOf(querySchema)}\`\n`
        }
        if (responseSchema) {
          output += `  - Response Schema: \`${tsTypeOf(responseSchema)}\`\n`
        }
        if (s?.errors) {
          for (const [status, errorSchema] of Object.entries(s.errors)) {
            const errJson = jsonSchemaOf(errorSchema)
            if (errJson) {
              output += `  - Error ${status} Schema: \`${tsTypeOf(errJson)}\`\n`
            }
          }
        }
      }
    }
  }

  return output
}
