import { definePlugin, type NodeRequestContext } from "@nifrajs/core/server"

export interface PrettyJsonOptions {
  /** JSON indentation spaces. Default `2`. */
  readonly spaces?: number
  /** Maximum response bytes to inspect. Default `1_000_000`; larger responses pass through. */
  readonly maxBytes?: number
  /** Append a final newline. Default `true`. */
  readonly newline?: boolean
  /** Optional query toggle. When set, pretty printing runs only when the parameter is present. */
  readonly query?: string | false
  /** Only pretty-print matching requests (the predicate receives the portable request view -
   * `{ method, url, header(name) }` - so the check runs without materializing a `Request`).
   * Default `true`. */
  readonly enabled?: boolean | ((request: NodeRequestContext) => boolean)
}

const JSON_TYPE = /^(?:application\/json|[^/]+\/[^;]+\+json)(?:\s*;|$)/i

function isJson(contentType: string): boolean {
  return JSON_TYPE.test(contentType)
}

/**
 * Pretty-print JSON responses for debugging and developer-facing APIs. It only touches JSON content,
 * skips encoded responses, caps inspection size, and leaves invalid JSON untouched.
 */
export function prettyJson(options: PrettyJsonOptions = {}) {
  const spaces = options.spaces ?? 2
  if (!Number.isInteger(spaces) || spaces < 0 || spaces > 10) {
    throw new Error("prettyJson: spaces must be an integer from 0 to 10")
  }
  const maxBytes = options.maxBytes ?? 1_000_000
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new Error("prettyJson: maxBytes must be a non-negative integer")
  }
  const newline = options.newline !== false
  const query = options.query ?? false
  if (query !== false && query.trim() === "") throw new Error("prettyJson: query is empty")
  const enabled = options.enabled ?? true
  const isEnabled = typeof enabled === "function" ? enabled : enabled ? () => true : () => false

  const decoder = new TextDecoder()
  return definePlugin("prettyJson", (app) =>
    app.use({
      // The portable body tier: the final framework-serialized bytes arrive already resident on
      // every runtime, so the old peek/replay stream machinery is gone entirely. Handler-returned
      // raw Responses (streams) pass through untouched by contract.
      onResponseBody(body, headers, req) {
        if (!isEnabled(req)) return undefined
        if (query !== false && !new URL(req.url).searchParams.has(query)) return undefined
        if (headers.has("content-encoding")) return undefined
        if (!isJson(headers.get("content-type") ?? "")) return undefined
        const text = typeof body === "string" ? body : decoder.decode(body)
        if (text.length > maxBytes) return undefined
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          return undefined
        }
        return `${JSON.stringify(parsed, null, spaces)}${newline ? "\n" : ""}`
      },
    }),
  )
}
