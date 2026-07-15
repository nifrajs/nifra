import { definePlugin } from "@nifrajs/core/server"

export interface PrettyJsonOptions {
  /** JSON indentation spaces. Default `2`. */
  readonly spaces?: number
  /** Maximum response bytes to inspect. Default `1_000_000`; larger responses pass through. */
  readonly maxBytes?: number
  /** Append a final newline. Default `true`. */
  readonly newline?: boolean
  /** Optional query toggle. When set, pretty printing runs only when the parameter is present. */
  readonly query?: string | false
  /** Only pretty-print matching requests. Default `true`. */
  readonly enabled?: boolean | ((request: Request) => boolean)
}

const JSON_TYPE = /^(?:application\/json|[^/]+\/[^;]+\+json)(?:\s*;|$)/i

function isJson(contentType: string): boolean {
  return JSON_TYPE.test(contentType)
}

function parseLength(value: string | null): number | undefined {
  if (value === null) return undefined
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return undefined
  return Number(value)
}

async function readTextCapped(res: Response, maxBytes: number): Promise<string | null> {
  const body = res.clone().body
  if (body === null) return null
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return null
      }
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    return null
  }
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

  return definePlugin("prettyJson", (app) =>
    app.onResponse(async (res, req) => {
      if (!isEnabled(req)) return res
      if (query !== false && !new URL(req.url).searchParams.has(query)) return res
      if (res.body === null || res.headers.has("content-encoding")) return res
      if (!isJson(res.headers.get("content-type") ?? "")) return res
      const declared = parseLength(res.headers.get("content-length"))
      if (declared !== undefined && declared > maxBytes) return res

      const text = await readTextCapped(res, maxBytes)
      if (text === null) return res
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return res
      }

      const headers = new Headers(res.headers)
      headers.delete("content-length")
      return new Response(`${JSON.stringify(parsed, null, spaces)}${newline ? "\n" : ""}`, {
        status: res.status,
        statusText: res.statusText,
        headers,
      })
    }),
  )
}
