const SCHEMA_PARTS = ["headers", "cookies", "body", "query", "params", "response"] as const

type SchemaPartKey = (typeof SCHEMA_PARTS)[number]

/**
 * Each request and response schema part of `source` that `map` turns into a value, under its own key,
 * in the order route reflections, evidence and snapshots all write them.
 */
export function mapSchemaParts<In, Out>(
  source: { readonly [K in SchemaPartKey]?: In },
  map: (part: In | undefined) => Out | undefined,
): { [K in SchemaPartKey]?: Out } {
  const parts: { [K in SchemaPartKey]?: Out } = {}
  for (const key of SCHEMA_PARTS) {
    const part = map(source[key])
    if (part !== undefined) parts[key] = part
  }
  return parts
}
