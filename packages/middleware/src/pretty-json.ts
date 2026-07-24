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

/**
 * The two reader methods this file uses, structurally.
 *
 * Named by use rather than imported: `lib.dom`'s `ReadableStreamDefaultReader` and Bun's augmented one
 * are not mutually assignable (Bun adds `readMany`), and `ReturnType<…getReader>` resolves to the BYOB
 * overload, whose `read` requires an argument. A structural shape sidesteps all of it without a cast.
 */
interface ChunkReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
}

/** Re-emit the bytes already pulled, then the untouched remainder of the same reader. */
function replayFrom(res: Response, chunks: readonly Uint8Array[], reader: ChunkReader): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        // No value and not done cannot happen for a byte stream, but it means the same thing here:
        // there is nothing further to emit.
        if (done || value === undefined) controller.close()
        else controller.enqueue(value)
      } catch (error) {
        // The upstream body failed; surface that to the client rather than truncating silently.
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

type Peeked = { readonly text: string } | { readonly response: Response }

/**
 * Read up to `maxBytes` of a response, without disturbing it when the answer is "pass through".
 *
 * `Response.clone()` is the obvious way to peek and is a trap here. Cancelling the clone's reader once
 * the cap is exceeded also stalls the ORIGINAL body in Bun, so an oversized streamed response hung the
 * client instead of passing through - a hang, from a middleware whose entire job is cosmetic. (A clone
 * read to completion is fine; only the cancel breaks it, which is why every buffered case passed and
 * only a streamed one failed.) Abandoning the clone rather than cancelling it trades the hang for
 * buffering the whole oversized body, which is the exact cost the cap exists to avoid.
 *
 * So the body is read directly and, when it proves too large, replayed: the bytes already pulled are
 * re-emitted ahead of the rest of the same reader. No tee, nothing buffered past the cap, and the
 * response the client receives is byte-for-byte the one the handler produced.
 */
async function peekText(res: Response, maxBytes: number): Promise<Peeked> {
  const body = res.body
  if (body === null) return { response: res }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        const decoder = new TextDecoder()
        let text = ""
        for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
        return { text: text + decoder.decode() }
      }
      chunks.push(value)
      total += value.byteLength
      if (total > maxBytes) return { response: replayFrom(res, chunks, reader) }
    }
  } catch {
    return { response: replayFrom(res, chunks, reader) }
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

      const peeked = await peekText(res, maxBytes)
      if ("response" in peeked) return peeked.response
      let parsed: unknown
      try {
        parsed = JSON.parse(peeked.text)
      } catch {
        // The body was read to decide that, so `res` can no longer be returned as-is. Rebuild it from
        // the text: re-encoding UTF-8 reproduces the original bytes, so `content-length` still holds.
        return new Response(peeked.text, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        })
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
