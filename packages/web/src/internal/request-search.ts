import type { StandardSchemaV1 } from "@nifrajs/core/server"
import { parseSearch, validateSearch } from "../search.ts"
import { isRecord } from "./record.ts"

interface RequestSearch {
  readonly raw: string
  readonly parsed: Record<string, unknown>
}

// A page request asks for its search from the loader context, the effective search and the render
// props. Keyed by the Request like the URL split, so the query is parsed once.
const REQUEST_SEARCH = new WeakMap<Request, RequestSearch>()

/** The parsed query as one reader's own copy: nested values are copied too, so no reader's edit reaches another's. */
function detach(parsed: Record<string, unknown>): Record<string, unknown> {
  const out = { ...parsed }
  for (const key in out) {
    const value = out[key]
    if (typeof value === "object" && value !== null) out[key] = structuredClone(value)
  }
  return out
}

/**
 * `searchOfChain` for one request. The output is the same value; the query is parsed once however many
 * times the request asks, and each caller validates its own copy of it.
 */
export function searchOfRequest(
  request: Request,
  schemas: readonly (StandardSchemaV1 | undefined)[],
  raw: string,
): Record<string, unknown> {
  let memo = REQUEST_SEARCH.get(request)
  if (memo === undefined || memo.raw !== raw) {
    memo = { raw, parsed: parseSearch(raw) }
    REQUEST_SEARCH.set(request, memo)
  }
  const parsed = detach(memo.parsed)
  let out: Record<string, unknown> | undefined
  for (const schema of schemas) {
    if (schema === undefined) continue
    const validated = validateSearch(schema, parsed)
    if (!isRecord(validated)) {
      throw new TypeError("[nifra/web] a search schema must produce an object")
    }
    out = { ...out, ...validated }
  }
  return out ?? parsed
}
