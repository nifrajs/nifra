import type { StandardSchemaV1 } from "@nifrajs/core/server"
import { parseSearch, validateSearch } from "../search.ts"
import { isRecord } from "./record.ts"

interface RequestSearch {
  readonly raw: string
  readonly parsed: Record<string, unknown>
  readonly outputs: Map<StandardSchemaV1, Record<string, unknown>>
}

// A page request asks for its search from the loader context, the effective search and the render
// props. Keyed by the Request like the URL split, so the query is parsed and each schema run once.
const REQUEST_SEARCH = new WeakMap<Request, RequestSearch>()

/**
 * `searchOfChain` for one request. The output is the same value; the query is parsed and each schema
 * validated once however many times the request asks, so nested values are shared between callers.
 */
export function searchOfRequest(
  request: Request,
  schemas: readonly (StandardSchemaV1 | undefined)[],
  raw: string,
): Record<string, unknown> {
  let memo = REQUEST_SEARCH.get(request)
  if (memo === undefined || memo.raw !== raw) {
    memo = { raw, parsed: parseSearch(raw), outputs: new Map() }
    REQUEST_SEARCH.set(request, memo)
  }
  let out: Record<string, unknown> | undefined
  for (const schema of schemas) {
    if (schema === undefined) continue
    let validated = memo.outputs.get(schema)
    if (validated === undefined) {
      const result = validateSearch(schema, memo.parsed)
      if (!isRecord(result)) {
        throw new TypeError("[nifra/web] a search schema must produce an object")
      }
      validated = result
      memo.outputs.set(schema, validated)
    }
    out = { ...out, ...validated }
  }
  return out ?? { ...memo.parsed }
}
