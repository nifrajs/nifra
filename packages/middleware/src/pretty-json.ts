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

interface ChunkReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
}

const concat = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function replayFrom(res: Response, chunks: readonly Uint8Array[], reader: ChunkReader): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done || value === undefined) controller.close()
        else controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel: (reason) => reader.cancel(reason),
  })
  return new Response(stream, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

type Peeked =
  | { readonly text: string; readonly bytes: Uint8Array }
  | { readonly response: Response }

async function peekText(res: Response, maxBytes: number): Promise<Peeked> {
  const body = res.body
  if (body === null) return { response: res }
  const reader = body.getReader() as unknown as ChunkReader
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        const decoder = new TextDecoder("utf-8", { fatal: true })
        let text = ""
        for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
        return { text: text + decoder.decode(), bytes: concat(chunks, total) }
      }
      if (value === undefined) return { response: replayFrom(res, chunks, reader) }
      chunks.push(value)
      total += value.byteLength
      if (total > maxBytes) return { response: replayFrom(res, chunks, reader) }
    }
  } catch {
    return { response: replayFrom(res, chunks, reader) }
  }
}

function requestView(request: Request): NodeRequestContext {
  return { method: request.method, url: request.url, header: (name) => request.headers.get(name) }
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
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("prettyJson: maxBytes must be a non-negative safe integer")
  }
  const newline = options.newline !== false
  const query = options.query ?? false
  if (query !== false && query.trim() === "") throw new Error("prettyJson: query is empty")
  const enabled = options.enabled ?? true
  const isEnabled = typeof enabled === "function" ? enabled : enabled ? () => true : () => false

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  return definePlugin("prettyJson", (app) =>
    app.use({
      onResponseBody(body, headers, req) {
        if (!isEnabled(req)) return undefined
        if (query !== false && !new URL(req.url).searchParams.has(query)) return undefined
        if (headers.has("content-encoding")) return undefined
        if (!isJson(headers.get("content-type") ?? "")) return undefined
        const text = typeof body === "string" ? body : decoder.decode(body)
        if (
          (typeof body === "string" ? encoder.encode(body).byteLength : body.byteLength) > maxBytes
        ) {
          return undefined
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          return undefined
        }
        return `${JSON.stringify(parsed, null, spaces)}${newline ? "\n" : ""}`
      },
      onResponseRaw(response, req) {
        if (!isEnabled(requestView(req))) return response
        if (query !== false && !new URL(req.url).searchParams.has(query)) return response
        if (
          response.body === null ||
          response.status === 204 ||
          response.status === 205 ||
          response.status === 304 ||
          response.headers.has("content-encoding")
        )
          return response
        if (!isJson(response.headers.get("content-type") ?? "")) return response
        const declared = response.headers.get("content-length")
        if (declared !== null && /^(?:0|[1-9]\d*)$/.test(declared) && Number(declared) > maxBytes) {
          return response
        }
        return prettyRawResponse(response, maxBytes, spaces, newline)
      },
    }),
  )
}

async function prettyRawResponse(
  response: Response,
  maxBytes: number,
  spaces: number,
  newline: boolean,
): Promise<Response> {
  const peeked = await peekText(response, maxBytes)
  if ("response" in peeked) return peeked.response
  let parsed: unknown
  try {
    parsed = JSON.parse(peeked.text)
  } catch {
    return new Response(peeked.bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(`${JSON.stringify(parsed, null, spaces)}${newline ? "\n" : ""}`, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
