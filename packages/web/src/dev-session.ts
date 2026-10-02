/**
 * One dev server's agent session, shared by both dev-server adapters (`./dev.ts`, `./vite.ts`) the way
 * `./dev-diagnostics.ts` is: the feed, its HTTP surface, request tracking, the discovery record, console
 * capture and the crash monitor live here once, so the two servers cannot drift on what an agent sees.
 *
 * Every agent read requires a loopback `Host` (a DNS-rebinding page cannot reach it) AND the token from
 * the discovery record (owner-only file), so a script running in the app's own pages cannot read logs
 * either. `/__nifra/last-error` keeps its older, token-free contract behind the same Host check.
 */
import { performance } from "node:perf_hooks"
import { createDevDiagnostics, type DevDiagnostics } from "./dev-diagnostics.ts"
import {
  captureInto,
  createDevFeed,
  createDevToken,
  DEV_ERROR_CATEGORIES,
  DEV_FEED_HEADER,
  DEV_FEED_PATHS,
  DEV_FEED_SCHEMA,
  DEV_LOG_LEVELS,
  DEV_REQUEST_ID_HEADER,
  DEV_TOKEN_HEADER,
  type DevFeed,
  type DevPipeline,
  type DevServerIdentity,
  removeDevServerRecord,
  runWithDevRequest,
  writeDevServerRecord,
} from "./dev-feed.ts"
import { LAST_ERROR_PATH } from "./diagnostic.ts"
import { timingSafeEqual } from "./internal/timing-safe-equal.ts"
import { ISR_STATUS_HEADER } from "./isr.ts"
import { browserDenial, createZoneClassifier } from "./zones.ts"

export interface DevSessionOptions {
  readonly root: string
  readonly pipeline: DevPipeline
  readonly publicEnvPrefix?: string | undefined
  /**
   * Write the discovery record and the persisted log under `<root>/.nifra/` (default true). Tools find a
   * running server through the record; turn it off only for a server nothing should discover.
   */
  readonly record?: boolean | undefined
}

/** What a dev server hands `createApp` so the app reports into the session. */
export interface DevAppHooks {
  /** Pass to `createWebApp({ onLoaderError })`: failures an `_error` boundary renders reach the feed. */
  readonly onLoaderError: (
    err: unknown,
    ctx: { readonly request: Request; readonly route: string; readonly params?: unknown },
  ) => void
}

export interface DevSession {
  readonly feed: DevFeed
  /** The agent token tools present as `x-nifra-dev-token`. */
  readonly token: string
  readonly diagnostics: DevDiagnostics
  /** Answer a `/__nifra/` agent path, or `undefined` for anything else. */
  handle(request: Request): Promise<Response | undefined>
  /** Run one app request as a tracked request: id header, trace, and entries tagged with its id. */
  track(request: Request, handler: () => Promise<Response>): Promise<Response>
  /** Record a failure that escaped the app and return the overlay HTML for it. */
  failure(err: unknown, request: { readonly method: string; readonly url: string }): string
  /** For `createWebApp({ onLoaderError })`: loader/action/render failures a boundary answered. */
  onLoaderError(
    err: unknown,
    ctx: { readonly request: Request; readonly route: string; readonly params?: unknown },
  ): void
  buildFailed(err: unknown, label: string): void
  buildPassed(): void
  markChange(): void
  listening(port: number): void
  stop(): void
}

const JSON_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  [DEV_FEED_HEADER]: "true",
}

/** A Host header naming this machine: localhost, `*.localhost`, 127.0.0.0/8, or `[::1]`. */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (host === null || host === undefined || host.length === 0) return false
  let name = host.trim().toLowerCase()
  if (name.startsWith("[")) {
    const end = name.indexOf("]")
    if (end === -1) return false
    name = name.slice(1, end)
  } else {
    const colon = name.lastIndexOf(":")
    if (colon !== -1) name = name.slice(0, colon)
  }
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
  )
}

const AGENT_PATHS: ReadonlySet<string> = new Set([
  DEV_FEED_PATHS.identity,
  DEV_FEED_PATHS.errors,
  DEV_FEED_PATHS.logs,
  DEV_FEED_PATHS.requests,
  DEV_FEED_PATHS.clientEvent,
  LAST_ERROR_PATH,
])

/** Whether `pathname` is one the session answers (so an adapter hands it over before its own routing). */
export function isDevAgentPath(pathname: string): boolean {
  return AGENT_PATHS.has(pathname)
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })

const intParam = (url: URL, name: string): number | undefined => {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === "") return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

const textParam = (url: URL, name: string): string | undefined => {
  const raw = url.searchParams.get(name)
  return raw === null || raw === "" ? undefined : raw
}

const listParam = <T extends string>(
  url: URL,
  name: string,
  allowed: readonly T[],
): T[] | undefined => {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === "") return undefined
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is T => allowed.some((value) => value === part))
}

const messageOf = (part: unknown): string => {
  if (part instanceof Error) return part.message
  if (typeof part === "object" && part !== null && "message" in part) {
    if (typeof part.message === "string") return part.message
  }
  return String(part)
}

/** A Bun BuildMessage's `position` (file, 1-based line, 0-based column), when it carries one. */
const positionOf = (
  part: unknown,
): { readonly file: string; readonly line: number; readonly column: number } | undefined => {
  if (typeof part !== "object" || part === null || !("position" in part)) return undefined
  const position: unknown = part.position
  if (typeof position !== "object" || position === null) return undefined
  if (!("file" in position) || typeof position.file !== "string") return undefined
  if (!("line" in position) || typeof position.line !== "number") return undefined
  const column = "column" in position && typeof position.column === "number" ? position.column : 0
  return { file: position.file, line: position.line, column }
}

/**
 * A bundler failure as an Error a Diagnostic can locate. Bun rejects with an AggregateError of
 * BuildMessages whose `position` names the file; that position becomes the top frame so the codeframe
 * points at the offending line.
 */
export function buildFailureError(err: unknown, label: string): Error {
  const parts: unknown[] =
    err instanceof AggregateError && err.errors.length > 0 ? err.errors : [err]
  const messages = parts.map(messageOf)
  const position = parts.map(positionOf).find((pos) => pos !== undefined)
  const error = new Error(`${label}\n${messages.map((m) => `  ${m}`).join("\n")}`)
  error.name = "BuildError"
  const frames =
    position !== undefined
      ? `    at ${position.file}:${position.line}:${position.column + 1}`
      : err instanceof Error && typeof err.stack === "string"
        ? err.stack
            .split("\n")
            .filter((line) => /^\s*at\s/.test(line))
            .join("\n")
        : ""
  error.stack = `BuildError: ${error.message}${frames === "" ? "" : `\n${frames}`}`
  return error
}

/** Create the session a dev server owns from construction to `stop()`. */
export function createDevSession(options: DevSessionOptions): DevSession {
  const { root, pipeline } = options
  const record = options.record !== false
  const zones = createZoneClassifier({ appRoot: root })
  const showSource = (file: string): boolean => browserDenial(zones.classify(file)) === undefined
  const feed = createDevFeed({
    root,
    persist: record,
    showSource,
    publicEnvPrefix: options.publicEnvPrefix,
  })
  const token = createDevToken()
  const startedAt = new Date().toISOString()
  let port = 0
  let requestCounter = 0
  let stopped = false

  const diagnostics = createDevDiagnostics(
    root,
    (err, request) => feed.recordError(err, { category: "ssr", request }).diagnostic,
  )

  const detachCapture = captureInto(feed)

  // Observes without changing what a crash does: the process still dies exactly as it would have.
  const onCrash = (err: unknown): void => {
    try {
      feed.recordError(err, { category: "process" })
      feed.flush()
    } catch {
      // Recording a crash must never mask it.
    }
  }
  process.on("uncaughtExceptionMonitor", onCrash)

  const identity = (): DevServerIdentity => ({
    schema: DEV_FEED_SCHEMA,
    pid: process.pid,
    port,
    pipeline,
    root,
    startedAt,
    cursor: feed.cursor,
    generation: feed.generation,
    counts: feed.counts(),
  })

  const authorized = (request: Request): boolean =>
    timingSafeEqual(request.headers.get(DEV_TOKEN_HEADER) ?? "", token)

  const handle = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url)
    const path = url.pathname
    if (!AGENT_PATHS.has(path)) return undefined
    if (!isLoopbackHost(request.headers.get("host") ?? url.host)) {
      return json(
        { code: "NIFRA_DEV_FORBIDDEN", message: "dev endpoints answer loopback hosts only" },
        403,
      )
    }
    if (path === LAST_ERROR_PATH) {
      const { body, headers } = diagnostics.lastError()
      return new Response(body, { headers })
    }
    if (path === DEV_FEED_PATHS.clientEvent) return ingestClientEvents(request)
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ code: "NIFRA_DEV_METHOD", message: "use GET" }, 405)
    }
    if (!authorized(request)) {
      return json(
        {
          code: "NIFRA_DEV_UNAUTHORIZED",
          message: `send the token from ${root}/.nifra/dev-server.json as ${DEV_TOKEN_HEADER}`,
        },
        401,
      )
    }
    if (path === DEV_FEED_PATHS.identity) return json(identity())
    const since = intParam(url, "since")
    const limit = intParam(url, "limit")
    const requestId = textParam(url, "requestId")
    if (path === DEV_FEED_PATHS.errors) {
      return json(
        feed.errors({
          since,
          limit,
          requestId,
          categories: listParam(url, "category", DEV_ERROR_CATEGORIES),
          includeStale: url.searchParams.get("stale") !== "false",
          includeResolved: url.searchParams.get("resolved") === "true",
        }),
      )
    }
    if (path === DEV_FEED_PATHS.logs) {
      const source = url.searchParams.get("source")
      return json(
        feed.logs({
          since,
          limit,
          requestId,
          levels: listParam(url, "level", DEV_LOG_LEVELS),
          source: source === "server" || source === "browser" ? source : undefined,
          grep: textParam(url, "grep"),
        }),
      )
    }
    return json(feed.requests({ since, limit, requestId, path: textParam(url, "path") }))
  }

  const ingestClientEvents = async (_request: Request): Promise<Response> =>
    json({ code: "NIFRA_DEV_NOT_FOUND", message: "browser capture is not enabled" }, 404)

  const track = async (request: Request, handler: () => Promise<Response>): Promise<Response> => {
    requestCounter += 1
    const requestId = `r${requestCounter}`
    const url = new URL(request.url)
    const path = `${url.pathname}${url.search}`
    feed.startRequest(requestId, request.method, path)
    const started = performance.now()
    let response: Response
    try {
      response = await runWithDevRequest(
        { feedId: feed.id, requestId, method: request.method, path },
        handler,
      )
    } catch (err) {
      feed.finishRequest(requestId, { status: 500 }, performance.now() - started)
      throw err
    }
    const length = response.headers.get("content-length")
    feed.finishRequest(
      requestId,
      {
        status: response.status,
        bytes: length !== null && /^\d+$/.test(length) ? Number(length) : undefined,
        isr: response.headers.get(ISR_STATUS_HEADER) ?? undefined,
      },
      performance.now() - started,
    )
    try {
      response.headers.set(DEV_REQUEST_ID_HEADER, requestId)
      return response
    } catch {
      // `Response.redirect()` and fetched responses carry immutable headers on some runtimes.
      const headers = new Headers(response.headers)
      headers.set(DEV_REQUEST_ID_HEADER, requestId)
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    }
  }

  return {
    feed,
    token,
    diagnostics,
    handle,
    track,
    failure: (err, request) => diagnostics.capture(err, request),
    onLoaderError: (err, ctx) => {
      const url = new URL(ctx.request.url)
      feed.recordError(err, {
        category: "page",
        route: ctx.route,
        request: { method: ctx.request.method, url: `${url.pathname}${url.search}` },
      })
    },
    buildFailed: (err, label) => {
      feed.recordError(buildFailureError(err, label), { category: "build" })
    },
    buildPassed: () => feed.resolve("build"),
    markChange: () => feed.markChange(),
    listening: (bound) => {
      port = bound
      if (!record) return
      try {
        writeDevServerRecord(root, {
          schema: DEV_FEED_SCHEMA,
          pid: process.pid,
          port: bound,
          url: `http://localhost:${bound}`,
          pipeline,
          root,
          startedAt,
          token,
        })
      } catch (err) {
        feed.recordLog(
          "warn",
          `[nifra] could not write ${root}/.nifra/dev-server.json; tools will need an explicit port: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
    stop: () => {
      if (stopped) return
      stopped = true
      detachCapture()
      process.off("uncaughtExceptionMonitor", onCrash)
      if (record) {
        try {
          removeDevServerRecord(root, token)
        } catch {
          // Already gone, or the directory is; nothing to clean.
        }
      }
      feed.close()
    },
  }
}
