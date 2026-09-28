import { realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export interface SmokeApp {
  fetch(request: Request): Response | Promise<Response>
}

export interface SmokeServer {
  readonly origin: string
  readonly fetch?: (request: Request) => Response | Promise<Response>
  stop(): void | Promise<void>
}

export interface SmokeRequestCheck {
  readonly id: string
  readonly path: string
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly expectedStatus: number
  readonly expectedHeaders?: Readonly<Record<string, string>>
  readonly contentType?: "json" | "text"
}

export interface SmokeSsrCheck {
  readonly path: string
  readonly marker: string
  readonly expectedStatus?: number
  readonly expectedHeaders?: Readonly<Record<string, string>>
}

export interface SmokeHookContext {
  readonly app: SmokeApp
  readonly origin: string
  request(check: SmokeRequestCheck): Promise<Response>
}

export interface SmokeContractResult {
  readonly ok: boolean
  readonly failures?: number
  readonly gaps?: number
}

export interface SmokeFixture {
  readonly app: SmokeApp
  /** Starts the built production server. Omit only when explicitly using in-process mode. */
  readonly start?: (app: SmokeApp) => SmokeServer | Promise<SmokeServer>
  /** Required SSR document check. */
  readonly ssr?: SmokeSsrCheck
  /** At least one mounted/API witness is required for a green smoke run. */
  readonly mountedApi?: readonly SmokeRequestCheck[]
  /** Defaults to GET /__nifra_smoke_missing__. */
  readonly notFound?: SmokeRequestCheck
  /** Header checks, including CSP/security headers when the application configures them. */
  readonly securityHeaders?: readonly SmokeRequestCheck[]
  /** Optional callback/guard witnesses; credentials stay inside the fixture. */
  readonly authCallbacks?: readonly SmokeRequestCheck[]
  /** Optional response-contract laboratory hook. Its result is summarized without payloads. */
  readonly contract?: (
    context: SmokeHookContext,
  ) => SmokeContractResult | Promise<SmokeContractResult>
  /** Optional browser hydration hook supplied by the application/test environment. */
  readonly hydration?: (context: SmokeHookContext) => void | Promise<void>
}

export interface SmokeRunOptions {
  /** Allow a deliberately in-process run without a production server start. Default false. */
  readonly inProcess?: boolean
}

export interface SmokeCheckResult {
  readonly id: string
  readonly status: "pass" | "fail" | "skip"
  readonly category:
    | "start"
    | "ssr"
    | "api"
    | "not-found"
    | "headers"
    | "auth"
    | "contract"
    | "hydration"
  readonly message?: string
}

export interface SmokeReport {
  readonly version: 1
  readonly ok: boolean
  readonly mode: "production" | "in-process"
  readonly checks: readonly SmokeCheckResult[]
  readonly counts: {
    readonly passed: number
    readonly failed: number
    readonly skipped: number
  }
}

const safeId = (value: string, fallback: string): string =>
  /^[A-Za-z0-9._-]{1,80}$/.test(value) ? value : fallback

const MAX_SMOKE_PATH_LENGTH = 4_096
const MAX_SMOKE_MARKER_LENGTH = 4_096
const MAX_SMOKE_BODY_LENGTH = 1_048_576
const MAX_SMOKE_RESPONSE_BODY_LENGTH = 1_048_576
const MAX_SMOKE_HEADER_NAME_LENGTH = 256
const MAX_SMOKE_HEADER_VALUE_LENGTH = 8_192
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/

function hasControlCharacter(value: string, includeBackslash = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f || (includeBackslash && code === 0x5c)) return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
}

function validRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SMOKE_PATH_LENGTH &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !SCHEME_PREFIX.test(value) &&
    !hasControlCharacter(value, true)
  )
}

function headerError(value: unknown, label: string): string | undefined {
  if (!isRecord(value)) return `${label} must be an object`
  for (const [name, headerValue] of Object.entries(value)) {
    if (name.length === 0 || name.length > MAX_SMOKE_HEADER_NAME_LENGTH || !HTTP_TOKEN.test(name))
      return `${label} contains an invalid header name`
    if (
      typeof headerValue !== "string" ||
      headerValue.length > MAX_SMOKE_HEADER_VALUE_LENGTH ||
      hasControlCharacter(headerValue)
    )
      return `${label} contains an invalid header value`
  }
  try {
    new Headers(value as Record<string, string>)
  } catch {
    return `${label} contains an invalid header`
  }
  return undefined
}

function requestCheckError(value: unknown, label: string): string | undefined {
  if (!isRecord(value)) return `${label} must be an object`
  if (typeof value.id !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(value.id))
    return `${label}.id must be a short safe identifier`
  if (!validRelativePath(value.path)) return `${label}.path must be a local absolute path`
  if (value.method !== undefined) {
    if (
      typeof value.method !== "string" ||
      value.method.length === 0 ||
      value.method.length > 32 ||
      !HTTP_TOKEN.test(value.method)
    )
      return `${label}.method is invalid`
  }
  if (!validStatus(value.expectedStatus)) return `${label}.expectedStatus is invalid`
  if (value.headers !== undefined) {
    const error = headerError(value.headers, `${label}.headers`)
    if (error !== undefined) return error
  }
  if (value.expectedHeaders !== undefined) {
    const error = headerError(value.expectedHeaders, `${label}.expectedHeaders`)
    if (error !== undefined) return error
  }
  if (
    value.body !== undefined &&
    (typeof value.body !== "string" || value.body.length > MAX_SMOKE_BODY_LENGTH)
  )
    return `${label}.body is invalid or too large`
  if (
    value.contentType !== undefined &&
    value.contentType !== "json" &&
    value.contentType !== "text"
  )
    return `${label}.contentType is invalid`
  const method = typeof value.method === "string" ? value.method.toUpperCase() : "GET"
  if (value.body !== undefined && (method === "GET" || method === "HEAD"))
    return `${label}.body cannot be used with ${method}`
  return undefined
}

function smokeSsrError(value: unknown): string | undefined {
  if (!isRecord(value)) return "ssr check must be an object"
  if (!validRelativePath(value.path)) return "ssr.path must be a local absolute path"
  if (
    typeof value.marker !== "string" ||
    value.marker.length === 0 ||
    value.marker.length > MAX_SMOKE_MARKER_LENGTH
  )
    return "ssr.marker must be non-empty and bounded"
  if (value.expectedStatus !== undefined && !validStatus(value.expectedStatus))
    return "ssr.expectedStatus is invalid"
  if (value.expectedHeaders !== undefined)
    return headerError(value.expectedHeaders, "ssr.expectedHeaders")
  return undefined
}

function fixtureError(fixture: unknown, inProcess: boolean): string | undefined {
  if (!isRecord(fixture)) return "fixture must export an object"
  const app = fixture.app
  if ((typeof app !== "object" && typeof app !== "function") || app === null)
    return "fixture.app must be an object with fetch(request)"
  if (typeof (app as { fetch?: unknown }).fetch !== "function")
    return "fixture.app.fetch must be a function"
  if (!inProcess && typeof fixture.start !== "function")
    return "fixture.start must be a function in production mode"
  if (inProcess && fixture.start !== undefined && typeof fixture.start !== "function")
    return "fixture.start must be a function when provided"
  if (fixture.ssr === undefined) return "SSR check is not configured"
  const ssrError = smokeSsrError(fixture.ssr)
  if (ssrError !== undefined) return ssrError

  const mountedApi = fixture.mountedApi
  if (!Array.isArray(mountedApi) || mountedApi.length === 0)
    return "at least one mounted API witness is required"
  for (let index = 0; index < mountedApi.length; index++) {
    const error = requestCheckError(mountedApi[index], `mountedApi[${index}]`)
    if (error !== undefined) return error
  }

  const notFound = fixture.notFound ?? {
    id: "not-found",
    path: "/__nifra_smoke_missing__",
    expectedStatus: 404,
  }
  const notFoundError = requestCheckError(notFound, "notFound")
  if (notFoundError !== undefined) return notFoundError
  if (!isRecord(notFound) || notFound.expectedStatus !== 404)
    return "notFound.expectedStatus must be 404"

  for (const [field, category] of [
    ["securityHeaders", "securityHeaders"],
    ["authCallbacks", "authCallbacks"],
  ] as const) {
    const checks = fixture[field]
    if (checks === undefined) continue
    if (!Array.isArray(checks)) return `${category} must be an array`
    for (let index = 0; index < checks.length; index++) {
      const error = requestCheckError(checks[index], `${category}[${index}]`)
      if (error !== undefined) return error
    }
  }
  if (fixture.contract !== undefined && typeof fixture.contract !== "function")
    return "contract must be a function"
  if (fixture.hydration !== undefined && typeof fixture.hydration !== "function")
    return "hydration must be a function"
  return undefined
}

const responseContentType = (response: Response): string =>
  response.headers.get("content-type")?.split(";", 1)[0] ?? ""

const expectedHeaderMatches = (
  response: Response,
  expected: Readonly<Record<string, string>> | undefined,
): boolean =>
  Object.entries(expected ?? {}).every(([name, value]) => response.headers.get(name) === value)

function responseLike(value: unknown): value is Response {
  if (value === null || typeof value !== "object") return false
  const candidate = value as {
    readonly status?: unknown
    readonly headers?: { readonly get?: unknown }
    readonly text?: unknown
    readonly body?: unknown
  }
  return (
    typeof candidate.status === "number" &&
    Number.isInteger(candidate.status) &&
    candidate.status >= 100 &&
    candidate.status <= 599 &&
    typeof candidate.headers?.get === "function" &&
    typeof candidate.text === "function" &&
    (candidate.body === null || typeof candidate.body === "object")
  )
}

async function boundedResponseText(
  response: Response,
): Promise<{ readonly text?: string; readonly tooLarge: boolean }> {
  if (response.body === null) return { text: "", tooLarge: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_SMOKE_RESPONSE_BODY_LENGTH) {
        try {
          await reader.cancel()
        } catch {
          // The response is already a failed witness; cancellation errors are not actionable here.
        }
        return { tooLarge: true }
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(bytes), tooLarge: false }
}

function requestFor(origin: string, check: SmokeRequestCheck): Request {
  const method = check.method ?? "GET"
  const headers = new Headers(check.headers)
  return new Request(new URL(check.path, origin).href, {
    method,
    headers,
    ...(check.body === undefined ? {} : { body: check.body }),
  })
}

function validateRequestCheck(
  check: SmokeRequestCheck,
  response: Response,
): Promise<{ readonly ok: boolean; readonly message?: string }> {
  return (async () => {
    if (!responseLike(response)) return { ok: false, message: "fetch returned an invalid response" }
    if (response.status !== check.expectedStatus) {
      return { ok: false, message: `status ${response.status}, expected ${check.expectedStatus}` }
    }
    if (!expectedHeaderMatches(response, check.expectedHeaders)) {
      return { ok: false, message: "expected header missing or mismatched" }
    }
    if (check.contentType !== undefined) {
      const expected = check.contentType === "json" ? "application/json" : "text/plain"
      if (responseContentType(response) !== expected) {
        return { ok: false, message: `content type ${responseContentType(response) || "missing"}` }
      }
      if (check.contentType === "json") {
        const body = await boundedResponseText(response)
        if (body.tooLarge) return { ok: false, message: "response body is too large" }
        try {
          JSON.parse(body.text ?? "")
        } catch {
          return { ok: false, message: "response is not valid JSON" }
        }
      }
    }
    return { ok: true }
  })()
}

/** Run the safe, bounded production smoke checks declared by one application fixture. */
export async function runSmoke(
  fixture: SmokeFixture,
  options: SmokeRunOptions = {},
): Promise<SmokeReport> {
  const checks: SmokeCheckResult[] = []
  const add = (
    category: SmokeCheckResult["category"],
    id: string,
    status: SmokeCheckResult["status"],
    message?: string,
  ): void => {
    checks.push({
      category,
      id: safeId(id, `${category}-${checks.length + 1}`),
      status,
      ...(message === undefined ? {} : { message }),
    })
  }

  const inProcess = options.inProcess === true
  const invalidFixture = fixtureError(fixture, inProcess)
  if (invalidFixture !== undefined) {
    add("start", "fixture", "fail", invalidFixture)
    return reportOf(checks, inProcess ? "in-process" : "production")
  }
  let server: SmokeServer | undefined
  try {
    if (inProcess) {
      add("start", "in-process", "pass")
    } else {
      try {
        server = await fixture.start!(fixture.app)
        if (
          server === null ||
          typeof server.origin !== "string" ||
          server.origin.trim() === "" ||
          typeof server.stop !== "function" ||
          (server.fetch !== undefined && typeof server.fetch !== "function")
        ) {
          add("start", "production-start", "fail", "start function returned an invalid server")
          return reportOf(checks, "production")
        }
        const originUrl = new URL(server.origin)
        if (
          (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") ||
          originUrl.username !== "" ||
          originUrl.password !== "" ||
          originUrl.pathname !== "/" ||
          originUrl.search !== "" ||
          originUrl.hash !== ""
        ) {
          add("start", "production-start", "fail", "production server origin is invalid")
          return reportOf(checks, "production")
        }
        add("start", "production-start", "pass")
      } catch {
        add("start", "production-start", "fail", "production server failed to start")
        return reportOf(checks, "production")
      }
    }

    const origin = server?.origin ?? "http://nifra-smoke.invalid"
    const fetchRequest = async (check: SmokeRequestCheck): Promise<Response> => {
      const request = requestFor(origin, check)
      return server?.fetch !== undefined
        ? await server.fetch(request)
        : inProcess
          ? await fixture.app.fetch(request)
          : await globalThis.fetch(request)
    }
    const hookContext: SmokeHookContext = { app: fixture.app, origin, request: fetchRequest }

    if (fixture.ssr === undefined) {
      add("ssr", "ssr", "fail", "SSR check is not configured")
    } else {
      try {
        const response = await fetchRequest({
          id: "ssr",
          path: fixture.ssr.path,
          expectedStatus: fixture.ssr.expectedStatus ?? 200,
          ...(fixture.ssr.expectedHeaders === undefined
            ? {}
            : { expectedHeaders: fixture.ssr.expectedHeaders }),
        })
        if (!responseLike(response)) {
          add("ssr", "ssr", "fail", "fetch returned an invalid response")
        } else if (response.status !== (fixture.ssr.expectedStatus ?? 200)) {
          add("ssr", "ssr", "fail", `status ${response.status}`)
        } else if (responseContentType(response) !== "text/html") {
          add("ssr", "ssr", "fail", "response is not HTML")
        } else {
          const body = await boundedResponseText(response)
          if (body.tooLarge) add("ssr", "ssr", "fail", "response body is too large")
          else if (!(body.text ?? "").includes(fixture.ssr.marker))
            add("ssr", "ssr", "fail", "SSR marker is missing")
          else if (!expectedHeaderMatches(response, fixture.ssr.expectedHeaders))
            add("ssr", "ssr", "fail", "expected header missing or mismatched")
          else add("ssr", "ssr", "pass")
        }
      } catch {
        add("ssr", "ssr", "fail", "SSR request failed")
      }
    }

    const mountedApi = fixture.mountedApi
    if (mountedApi === undefined || mountedApi.length === 0) {
      add("api", "mounted-api", "fail", "at least one mounted API witness is required")
    } else {
      for (const check of mountedApi) {
        try {
          const result = await validateRequestCheck(check, await fetchRequest(check))
          add("api", check.id, result.ok ? "pass" : "fail", result.message)
        } catch {
          add("api", check.id, "fail", "mounted API request failed")
        }
      }
    }

    const notFound = fixture.notFound ?? {
      id: "not-found",
      path: "/__nifra_smoke_missing__",
      expectedStatus: 404,
    }
    try {
      const result = await validateRequestCheck(notFound, await fetchRequest(notFound))
      add("not-found", notFound.id, result.ok ? "pass" : "fail", result.message)
    } catch {
      add("not-found", notFound.id, "fail", "404 request failed")
    }

    for (const check of fixture.securityHeaders ?? []) {
      try {
        const result = await validateRequestCheck(check, await fetchRequest(check))
        add("headers", check.id, result.ok ? "pass" : "fail", result.message)
      } catch {
        add("headers", check.id, "fail", "security-header request failed")
      }
    }
    if (fixture.securityHeaders === undefined) add("headers", "security-headers", "skip")

    for (const check of fixture.authCallbacks ?? []) {
      try {
        const result = await validateRequestCheck(check, await fetchRequest(check))
        add("auth", check.id, result.ok ? "pass" : "fail", result.message)
      } catch {
        add("auth", check.id, "fail", "auth callback request failed")
      }
    }
    if (fixture.authCallbacks === undefined) add("auth", "auth-callbacks", "skip")

    if (fixture.contract === undefined) {
      add("contract", "response-contract", "skip")
    } else {
      try {
        const result = await fixture.contract(hookContext)
        if (
          result === undefined ||
          typeof result !== "object" ||
          result === null ||
          typeof result.ok !== "boolean" ||
          (result.failures !== undefined &&
            (!Number.isInteger(result.failures) || result.failures < 0)) ||
          (result.gaps !== undefined && (!Number.isInteger(result.gaps) || result.gaps < 0))
        ) {
          add("contract", "response-contract", "fail", "contract hook returned no verdict")
        } else if (!result.ok || (result.failures ?? 0) > 0 || (result.gaps ?? 0) > 0) {
          add("contract", "response-contract", "fail", "contract witnesses failed")
        } else {
          add("contract", "response-contract", "pass")
        }
      } catch {
        add("contract", "response-contract", "fail", "contract hook failed")
      }
    }

    if (fixture.hydration === undefined) {
      add("hydration", "hydration", "skip")
    } else {
      try {
        await fixture.hydration(hookContext)
        add("hydration", "hydration", "pass")
      } catch {
        add("hydration", "hydration", "fail", "hydration hook failed")
      }
    }
  } finally {
    if (server !== undefined) {
      try {
        await server.stop()
      } catch {
        add("start", "production-stop", "fail", "production server failed to stop")
      }
    }
  }
  return reportOf(checks, inProcess ? "in-process" : "production")
}

function reportOf(checks: readonly SmokeCheckResult[], mode: SmokeReport["mode"]): SmokeReport {
  const passed = checks.filter((check) => check.status === "pass").length
  const failed = checks.filter((check) => check.status === "fail").length
  const skipped = checks.length - passed - failed
  return {
    version: 1,
    ok: failed === 0,
    mode,
    checks: Object.freeze([...checks]),
    counts: { passed, failed, skipped },
  }
}

/** Load a user-owned smoke fixture without executing arbitrary project code during catalog/help. */
export async function loadSmokeFixture(
  cwd: string,
  fixturePath = "nifra.smoke.ts",
): Promise<SmokeFixture> {
  if (typeof fixturePath !== "string" || fixturePath.length === 0 || fixturePath.length > 256)
    throw new Error("smoke fixture path must be a non-empty bounded project-relative path")
  const path = resolve(cwd, fixturePath)
  const projectRoot = await realpath(cwd).catch(() => undefined)
  const fixtureRoot = await realpath(path).catch(() => undefined)
  if (projectRoot === undefined || fixtureRoot === undefined)
    throw new Error("smoke fixture not found")
  const relativeFixture = relative(projectRoot, fixtureRoot)
  if (relativeFixture === "" || relativeFixture.startsWith("..") || isAbsolute(relativeFixture))
    throw new Error("smoke fixture must be inside the project")
  const fixtureStats = await stat(fixtureRoot).catch(() => undefined)
  if (fixtureStats === undefined || !fixtureStats.isFile())
    throw new Error("smoke fixture must resolve to a file")
  const specifier = pathToFileURL(fixtureRoot)
  specifier.searchParams.set("nifra-smoke", String(Date.now()))
  const loaded = (await import(specifier.href)) as { default?: unknown }
  const fixture = loaded.default
  if (fixture === null || typeof fixture !== "object") {
    throw new Error("smoke fixture must default-export an object")
  }
  return fixture as SmokeFixture
}
