import { definePlugin, pathnameOf } from "@nifrajs/core/server"

const JSON_TYPE = /^(?:application\/json|[^/]+\/[^;]+\+json)(?:\s*;|$)/i
const DEFAULT_MAX_BYTES = 64 * 1024

const STATUS_TITLES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  507: "Insufficient Storage",
}

export interface ProblemDetailsOptions {
  /** Include only the request pathname as `instance`. Query strings are never included. Default false. */
  readonly includeInstance?: boolean
  /** Prefix for code-specific problem types. Default `about:blank`. */
  readonly typeBase?: string
  /** Maximum JSON error body inspected. Default 64 KiB. */
  readonly maxBytes?: number
}

interface ErrorEnvelope {
  readonly error: string
  readonly issues?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readEnvelope(
  body: string | Uint8Array,
  contentType: string | null,
  maxBytes: number,
): ErrorEnvelope | undefined {
  if (contentType === null || !JSON_TYPE.test(contentType)) return undefined
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
  if (bytes.byteLength > maxBytes) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed.ok !== false || typeof parsed.error !== "string") {
    return undefined
  }
  return {
    error: parsed.error,
    ...(Object.hasOwn(parsed, "issues") ? { issues: parsed.issues } : {}),
  }
}

async function readCappedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        return bytes
      }

      if (size + result.value.byteLength > maxBytes) {
        void reader.cancel().catch(() => {})
        return undefined
      }

      chunks.push(result.value)
      size += result.value.byteLength
    }
  } catch {
    void reader.cancel().catch(() => {})
    return undefined
  }
}

function problemType(typeBase: string | undefined, code: string): string {
  if (typeBase === undefined) return "about:blank"
  return `${typeBase.replace(/\/+$/, "")}/${encodeURIComponent(code)}`
}

function problemDocument(
  status: number,
  envelope: ErrorEnvelope,
  typeBase: string | undefined,
  instance: string | undefined,
): Record<string, unknown> {
  const document: Record<string, unknown> = {
    type: problemType(typeBase, envelope.error),
    title: STATUS_TITLES[status] ?? "HTTP Error",
    status,
    code: envelope.error,
  }
  if (envelope.issues !== undefined) document.issues = envelope.issues
  if (instance !== undefined) document.instance = instance
  return document
}

function isAlreadyProblemDetails(contentType: string | null): boolean {
  return contentType?.toLowerCase().startsWith("application/problem+json") === true
}

/**
 * Opt-in RFC 9457 formatting for Nifra's structured error envelope.
 *
 * The default `{ ok: false, error }` response remains unchanged. This plugin only converts that
 * framework envelope, so custom JSON errors and already-formatted problem documents pass through.
 * Raw JSON error Responses are supported through a capped clone; encoded responses are never drained.
 */
export function problemDetails(options: ProblemDetailsOptions = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("problemDetails: maxBytes must be a non-negative safe integer")
  }
  const instance = options.includeInstance === true
  const typeBase = options.typeBase

  return definePlugin("problemDetails", (app) =>
    app.use({
      onResponseBody(body, headers, req, status) {
        if (
          status < 400 ||
          status >= 600 ||
          headers.has("content-encoding") ||
          isAlreadyProblemDetails(headers.get("content-type"))
        ) {
          return undefined
        }
        const envelope = readEnvelope(body, headers.get("content-type"), maxBytes)
        if (envelope === undefined) return undefined
        const document = problemDocument(
          status,
          envelope,
          typeBase,
          instance ? pathnameOf(req.url) : undefined,
        )
        headers.set("content-type", "application/problem+json")
        headers.delete("content-length")
        return JSON.stringify(document)
      },
      async onResponseRaw(response, req) {
        if (
          response.status < 400 ||
          response.status >= 600 ||
          response.body === null ||
          response.headers.has("content-encoding") ||
          isAlreadyProblemDetails(response.headers.get("content-type"))
        ) {
          return response
        }
        let bytes: Uint8Array | undefined
        try {
          const clone = response.clone()
          if (clone.body === null) return response
          bytes = await readCappedBody(clone.body, maxBytes)
        } catch {
          return response
        }
        if (bytes === undefined) return response
        const envelope = readEnvelope(bytes, response.headers.get("content-type"), maxBytes)
        if (envelope === undefined) return response
        const headers = new Headers(response.headers)
        headers.set("content-type", "application/problem+json")
        headers.delete("content-length")
        return new Response(
          JSON.stringify(
            problemDocument(
              response.status,
              envelope,
              typeBase,
              instance ? pathnameOf(req.url) : undefined,
            ),
          ),
          { status: response.status, statusText: response.statusText, headers },
        )
      },
    }),
  )
}
