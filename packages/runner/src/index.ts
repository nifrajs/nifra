/**
 * Run requests through a nifra app and capture **structured results** — the shared engine behind the
 * website playground (humans) and the agent run/verify tool (AI writes code → runs it → sees the
 * failure → fixes). It only touches `app.fetch(Request) → Response`, which is Web-standard, so it runs
 * unchanged in the browser, Bun, Node, Deno, and on the edge — and depends on nothing.
 *
 *   import { runApp } from "@nifrajs/runner"
 *   const results = await runApp(app, [
 *     { path: "/users/1" },
 *     { method: "POST", path: "/users", body: { name: "Ada" } },
 *   ])
 *   // → [{ status: 200, ok: true, body: {...}, durationMs }, …]
 *
 * It is a *runner*, not a security sandbox: it calls the app you hand it in-process, with no isolation.
 * Isolation, when you need it, comes from the host — the browser tab for the playground, your own
 * process/CI for the agent runner. Don't feed it code you wouldn't already run.
 */

/** Anything with a Web-standard fetch handler — a nifra app, or any `(Request) => Response`. Declared
 * structurally so this package has zero dependency on `@nifrajs/core`. */
export interface AppLike {
  fetch(request: Request): Response | Promise<Response>
}

/** One request to drive through the app. */
export interface RequestSpec {
  /** HTTP method. Default `"GET"`. */
  readonly method?: string
  /** Path (`"/users/1"`) or an absolute URL. Relative paths resolve against a local origin. */
  readonly path: string
  /** Request headers. */
  readonly headers?: Readonly<Record<string, string>>
  /** Body. A plain object/array is JSON-encoded (with a JSON content-type unless you set one); a
   * string/`Uint8Array` is sent as-is. Ignored for GET/HEAD (those can't carry a body). */
  readonly body?: unknown
  /** Optional label echoed back on the result (handy in the playground UI). */
  readonly label?: string
}

/** The captured outcome of one request. */
export interface RunResult {
  readonly label?: string
  readonly method: string
  readonly path: string
  /** `true` when the app returned a 2xx response. `false` for non-2xx, or when `app.fetch` threw. */
  readonly ok: boolean
  /** HTTP status — present when the app returned a response (absent when it threw). */
  readonly status?: number
  readonly statusText?: string
  readonly headers?: Readonly<Record<string, string>>
  /** Parsed JSON when the response is JSON; otherwise the (possibly truncated) text. */
  readonly body?: unknown
  /** The response body as text, truncated to `maxBodyChars`. */
  readonly bodyText?: string
  /** `true` when `bodyText` was cut to the cap. */
  readonly truncated?: boolean
  /** Wall-clock time for this request, milliseconds. */
  readonly durationMs: number
  /** Set when `app.fetch` threw (the app crashed) rather than returning a response. */
  readonly error?: { readonly name: string; readonly message: string; readonly stack?: string }
}

export interface RunOptions {
  /** Origin used to resolve relative paths. Default `"http://nifra.local"`. */
  readonly origin?: string
  /** Cap on captured body text, in characters. Default 65536. */
  readonly maxBodyChars?: number
}

const DEFAULT_ORIGIN = "http://nifra.local"
const DEFAULT_MAX_BODY = 64 * 1024

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now()

const METHODS_WITHOUT_BODY: ReadonlySet<string> = new Set(["GET", "HEAD"])

/** A plain JSON-ish object/array (encode it as JSON) — vs a string/binary body we pass through. */
function isJsonBody(body: unknown): body is Record<string, unknown> | unknown[] {
  if (body === null || typeof body !== "object") return false
  if (body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof Blob)
    return false
  if (typeof FormData !== "undefined" && body instanceof FormData) return false
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return false
  return true
}

function buildRequest(spec: RequestSpec, origin: string): Request {
  const method = (spec.method ?? "GET").toUpperCase()
  const url = /^https?:\/\//i.test(spec.path) ? spec.path : new URL(spec.path, origin).toString()

  const headers = new Headers(spec.headers as Record<string, string> | undefined)
  const init: RequestInit = { method, headers }

  if (spec.body !== undefined && !METHODS_WITHOUT_BODY.has(method)) {
    if (isJsonBody(spec.body)) {
      if (!headers.has("content-type")) headers.set("content-type", "application/json")
      init.body = JSON.stringify(spec.body)
    } else {
      init.body = spec.body as RequestInit["body"]
    }
  }
  return new Request(url, init)
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

/** Drive a single request through the app, capturing the outcome (never throws — a thrown app error
 * becomes `result.error`). */
export async function runRequest(
  app: AppLike,
  spec: RequestSpec,
  options: RunOptions = {},
): Promise<RunResult> {
  const origin = options.origin ?? DEFAULT_ORIGIN
  const maxBody = options.maxBodyChars ?? DEFAULT_MAX_BODY
  const method = (spec.method ?? "GET").toUpperCase()
  const base = {
    ...(spec.label === undefined ? {} : { label: spec.label }),
    method,
    path: spec.path,
  }

  const start = now()
  let request: Request
  try {
    request = buildRequest(spec, origin)
  } catch (err) {
    // A malformed spec (bad URL, GET-with-body via a custom method, …) — report it, don't throw.
    return { ...base, ok: false, durationMs: now() - start, error: toError(err) }
  }

  try {
    const res = await app.fetch(request)
    const text = await res.text()
    const truncated = text.length > maxBody
    const bodyText = truncated ? text.slice(0, maxBody) : text
    const contentType = res.headers.get("content-type") ?? ""
    let body: unknown = bodyText
    if (contentType.includes("application/json") && text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        // Content-Type lied, or the body is partial — keep the text form.
      }
    }
    return {
      ...base,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: headersToObject(res.headers),
      body,
      bodyText,
      ...(truncated ? { truncated } : {}),
      durationMs: now() - start,
    }
  } catch (err) {
    return { ...base, ok: false, durationMs: now() - start, error: toError(err) }
  }
}

function toError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) }
  }
  return { name: "Error", message: String(err) }
}

/**
 * Run a batch of requests through the app, in order, and return a result per request. Never throws:
 * an app crash on any request is captured as that result's `error` and the run continues.
 */
export function runApp(
  app: AppLike,
  requests: readonly RequestSpec[],
  options: RunOptions = {},
): Promise<RunResult[]> {
  return requests.reduce<Promise<RunResult[]>>(async (acc, spec) => {
    const results = await acc
    results.push(await runRequest(app, spec, options))
    return results
  }, Promise.resolve([]))
}
