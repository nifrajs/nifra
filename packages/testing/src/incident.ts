/**
 * Turn a failed request into a committed regression test — the one thing a generic error tracker
 * (Sentry, PostHog) can't do, because it needs the framework's contract + in-process replay. Capture
 * the request + observed response, replay it against the CURRENT app, and assert the response contract
 * (status, optionally shape) still reproduces. This does NOT replace error tracking or store incidents
 * — it converts one into a permanent test.
 *
 * Two surfaces, deliberately separate on the PII axis:
 *   - `replayIncident` / `assertIncidentReplays` run in memory against the REAL captured inputs — nothing
 *     is written, so reproduction is exact and there is no leak surface.
 *   - `generateRegressionTest` emits a file you commit, so it redacts request values BY DEFAULT and
 *     bannered a sanitize step: a committed fixture must never carry raw PII/secrets.
 */

import type { AppLike } from "./session.ts"

export interface CapturedRequestInput {
  readonly method?: string
  readonly path: string
  readonly query?: Record<string, string>
  readonly headers?: Record<string, string>
  readonly body?: unknown
}

export interface CapturedRequest {
  readonly method: string
  readonly path: string
  readonly query?: Record<string, string>
  readonly headers?: Record<string, string>
  readonly body?: unknown
}

export interface IncidentCapsule {
  readonly id: string
  readonly capturedAt: string
  readonly request: CapturedRequest
  readonly response: { readonly status: number; readonly bodyShape?: unknown }
  readonly note?: string
}

export interface CaptureIncidentOptions {
  readonly id?: string
  readonly capturedAt?: string
  /** Header names to keep on the capsule (lowercased match). Default: only `content-type`. */
  readonly headerAllowList?: readonly string[]
  readonly note?: string
}

export interface IncidentReplayResult {
  readonly reproduced: boolean
  readonly status: number
  readonly expectedStatus: number
  readonly statusMatches: boolean
  /** null when shape was not checked. */
  readonly shapeMatches: boolean | null
}

const DEFAULT_ORIGIN = "http://nifra.internal"
const DEFAULT_HEADER_ALLOW = ["content-type"]

function newId(): string {
  return `inc_${globalThis.crypto.randomUUID()}`
}

/** A stable structural fingerprint: keys + value *types*, not values. Used for the optional shape check. */
export function shapeOf(value: unknown): unknown {
  if (value === null) return "null"
  if (Array.isArray(value)) return value.length === 0 ? "[]" : [shapeOf(value[0])]
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = shapeOf((value as Record<string, unknown>)[key])
    }
    return out
  }
  return typeof value
}

function shapesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function readBody(source: Request | Response): Promise<unknown> {
  const contentType = source.headers.get("content-type") ?? ""
  const clone = source.clone()
  const text = await clone.text()
  if (text === "") return undefined
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

function pickHeaders(
  headers: Headers,
  allow: readonly string[],
): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  const allowed = new Set(allow.map((name) => name.toLowerCase()))
  for (const [key, value] of headers.entries()) {
    if (allowed.has(key.toLowerCase())) out[key.toLowerCase()] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Build a capsule from a real `Request`+`Response`, or from plain captured fields. */
export async function captureIncident(
  request: Request | CapturedRequestInput,
  response: Response | { status: number; body?: unknown },
  options: CaptureIncidentOptions = {},
): Promise<IncidentCapsule> {
  const allow = options.headerAllowList ?? DEFAULT_HEADER_ALLOW
  const req: {
    method: string
    path: string
    query?: Record<string, string>
    headers?: Record<string, string>
    body?: unknown
  } = { method: "GET", path: "/" }
  if (request instanceof Request) {
    const url = new URL(request.url)
    const query = Object.fromEntries(url.searchParams.entries())
    const headers = pickHeaders(request.headers, allow)
    const body = await readBody(request)
    req.method = request.method
    req.path = url.pathname
    if (Object.keys(query).length > 0) req.query = query
    if (headers !== undefined) req.headers = headers
    if (body !== undefined) req.body = body
  } else {
    req.method = request.method ?? "GET"
    req.path = request.path
    if (request.query !== undefined) req.query = request.query
    if (request.headers !== undefined) req.headers = request.headers
    if (request.body !== undefined) req.body = request.body
  }

  let status: number
  let responseBody: unknown
  if (response instanceof Response) {
    status = response.status
    responseBody = await readBody(response)
  } else {
    status = response.status
    responseBody = response.body
  }

  return {
    id: options.id ?? newId(),
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    request: req,
    response: {
      status,
      ...(responseBody !== undefined ? { bodyShape: shapeOf(responseBody) } : {}),
    },
    ...(options.note !== undefined ? { note: options.note } : {}),
  }
}

function buildRequest(capsule: IncidentCapsule, origin: string): Request {
  const url = new URL(capsule.request.path, origin)
  for (const [key, value] of Object.entries(capsule.request.query ?? {})) {
    url.searchParams.set(key, value)
  }
  const headers = new Headers(capsule.request.headers)
  const hasBody = capsule.request.body !== undefined
  if (hasBody && !headers.has("content-type")) headers.set("content-type", "application/json")
  const init: RequestInit = { method: capsule.request.method, headers }
  if (hasBody) init.body = JSON.stringify(capsule.request.body)
  return new Request(url.toString(), init)
}

export interface ReplayIncidentOptions {
  readonly origin?: string
  /** Also require the response body SHAPE to match the captured shape (not just status). Default false. */
  readonly assertShape?: boolean
}

/** Replay a captured incident against the current app and report whether it reproduces. */
export async function replayIncident(
  app: AppLike,
  capsule: IncidentCapsule,
  options: ReplayIncidentOptions = {},
): Promise<IncidentReplayResult> {
  const origin = options.origin ?? DEFAULT_ORIGIN
  const response = await app.fetch(buildRequest(capsule, origin))
  const statusMatches = response.status === capsule.response.status

  let shapeMatches: boolean | null = null
  if (options.assertShape === true) {
    const body = await readBody(response)
    shapeMatches = shapesEqual(shapeOf(body), capsule.response.bodyShape ?? undefined)
  }

  return {
    reproduced: statusMatches && shapeMatches !== false,
    status: response.status,
    expectedStatus: capsule.response.status,
    statusMatches,
    shapeMatches,
  }
}

export class IncidentReplayError extends Error {
  readonly result: IncidentReplayResult
  readonly capsuleId: string
  constructor(capsule: IncidentCapsule, result: IncidentReplayResult) {
    const parts = [`expected status ${result.expectedStatus}, got ${result.status}`]
    if (result.shapeMatches === false) parts.push("response shape diverged")
    super(
      `incident ${capsule.id} (${capsule.request.method} ${capsule.request.path}) no longer reproduces: ${parts.join("; ")}`,
    )
    this.name = "IncidentReplayError"
    this.result = result
    this.capsuleId = capsule.id
  }
}

/** Assert a captured incident still reproduces against the current app. Throws {@link IncidentReplayError}. */
export async function assertIncidentReplays(
  app: AppLike,
  capsule: IncidentCapsule,
  options: ReplayIncidentOptions = {},
): Promise<void> {
  const result = await replayIncident(app, capsule, options)
  if (!result.reproduced) throw new IncidentReplayError(capsule, result)
}

const REDACTED = "<redacted>"

/**
 * Redact leaf string values by default (unless the dotted key path is allow-listed). Non-strings are
 * kept — they carry the structure that makes the fixture reproduce — so review the emitted file. This
 * is intentionally aggressive: a committed fixture must not leak PII/secrets.
 */
export function redactForEmission(value: unknown, allow: ReadonlySet<string>, path = ""): unknown {
  if (typeof value === "string") return allow.has(path) ? value : REDACTED
  if (Array.isArray(value)) return value.map((item, i) => redactForEmission(item, allow, `${path}[${i}]`))
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactForEmission(val, allow, path === "" ? key : `${path}.${key}`)
    }
    return out
  }
  return value
}

export interface GenerateRegressionTestOptions {
  /** Import specifier for the app under test. Default `"../src/app"`. */
  readonly importPath?: string
  /** Named export of the app. Default `"app"`. */
  readonly appExport?: string
  /** Also assert the response shape. Default false (status-only is the robust regression signal). */
  readonly assertShape?: boolean
  /** Dotted key paths in the request body whose string values are safe to embed verbatim. */
  readonly allow?: readonly string[]
}

/**
 * Emit a committable regression test from a capsule. Request string values are redacted BY DEFAULT with
 * a sanitize banner — replace the `<redacted>` placeholders with safe, reproducing values before you
 * commit. The test asserts the response contract via {@link assertIncidentReplays}.
 */
export function generateRegressionTest(
  capsule: IncidentCapsule,
  options: GenerateRegressionTestOptions = {},
): string {
  const importPath = options.importPath ?? "../src/app"
  const appExport = options.appExport ?? "app"
  const allow = new Set(options.allow ?? [])
  const safeRequest: CapturedRequest = {
    ...capsule.request,
    ...(capsule.request.body !== undefined
      ? { body: redactForEmission(capsule.request.body, allow) }
      : {}),
  }
  const emitted: IncidentCapsule = { ...capsule, request: safeRequest }
  const redacted = JSON.stringify(emitted, null, 2).includes(REDACTED)

  return `// GENERATED by nifra incident → regression.
${redacted ? "// ⚠️  SANITIZE BEFORE COMMITTING: replace every \"<redacted>\" with a safe, non-PII value that\n//     still reproduces the response. A committed fixture must not carry PII or secrets.\n" : ""}// Asserts the response CONTRACT (status${options.assertShape ? " + shape" : ""}) still reproduces.
import { describe, it } from "bun:test"
import { assertIncidentReplays, type IncidentCapsule } from "@nifrajs/testing"
import { ${appExport} } from "${importPath}"

const capsule: IncidentCapsule = ${JSON.stringify(emitted, null, 2)}

describe("regression: ${capsule.request.method} ${capsule.request.path}", () => {
  it("reproduces status ${capsule.response.status}", async () => {
    await assertIncidentReplays(${appExport}, capsule, { assertShape: ${options.assertShape === true} })
  })
})
`
}
