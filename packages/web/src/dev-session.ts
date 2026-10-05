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
import {
  type BrowserError,
  CLIENT_BATCH_MAX_BYTES,
  type ClientEvent,
  type DevClientConfig,
  devClientTag,
  injectIntoHtml,
  injectIntoStream,
  isInjectablePage,
  parseClientBatch,
} from "./dev-client.ts"
import { createDevDiagnostics, createSourceGate, type DevDiagnostics } from "./dev-diagnostics.ts"
import {
  captureInto,
  createDevFeed,
  createDevToken,
  currentDevRequest,
  DEV_ERROR_CATEGORIES,
  DEV_FEED_HEADER,
  DEV_FEED_PATHS,
  DEV_FEED_SCHEMA,
  DEV_LOG_LEVELS,
  DEV_REQUEST_ID_HEADER,
  DEV_TOKEN_HEADER,
  type DevErrorEntry,
  type DevFeed,
  type DevPipeline,
  type DevServerIdentity,
  type LogMeta,
  removeDevServerRecord,
  runWithDevRequest,
  writeDevServerRecord,
} from "./dev-feed.ts"
import { DEV_INDICATOR_MAX_ISSUES, DEV_INDICATOR_SOURCE, type DevIssue } from "./dev-indicator.ts"
import { createSourceMapper } from "./dev-sourcemap.ts"
import { fixPrompts, isHydrationMismatch, LAST_ERROR_PATH, promptPath } from "./diagnostic.ts"
import { diagnosticHeadline } from "./diagnostic-prompt.ts"
import { timingSafeEqual } from "./internal/timing-safe-equal.ts"
import { ISR_STATUS_HEADER } from "./isr.ts"
import { DATA_HEADER } from "./router.ts"

export interface DevSessionOptions {
  readonly root: string
  readonly pipeline: DevPipeline
  readonly publicEnvPrefix?: string | undefined
  /**
   * Write the discovery record and the persisted log under `<root>/.nifra/` (default true). Tools find a
   * running server through the record; turn it off only for a server nothing should discover.
   */
  readonly record?: boolean | undefined
  /** Show browser errors in an in-page indicator with agent prompts (default true). */
  readonly indicator?: boolean | undefined
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
  /**
   * Run one app request as a tracked request: id header, trace, and entries tagged with its id. A page
   * load the app answers with a bare 5xx after recording an error comes back as the overlay instead.
   */
  track(request: Request, handler: () => Promise<Response>): Promise<Response>
  /** True for an overlay {@link track} returned: serve it as is, with no dev scripts added. */
  isOverlay(response: Response): boolean
  /**
   * The page response with the browser-capture script first in its `<head>` (streamed, not buffered)
   * and its CSP admitting the script. Anything that is not an HTML page comes back untouched.
   */
  decoratePage(request: Request, response: Response): Response
  /**
   * {@link decoratePage} for a page already in memory (the Vite pipeline, which nonces every script
   * after this): rewrites `headers` in place and leaves script admission to that nonce.
   */
  decorateHtml(request: Request, html: string, headers: Headers, requestId?: string | null): string
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
  DEV_FEED_PATHS.indicator,
  LAST_ERROR_PATH,
])

/** Whether `pathname` is one the session answers (so an adapter hands it over before its own routing). */
export function isDevAgentPath(pathname: string): boolean {
  return AGENT_PATHS.has(pathname)
}

const INDICATOR_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/javascript; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  [DEV_FEED_HEADER]: "true",
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

/** The origin the browser used for this request (its own Host, which the session already vetted). */
const originOf = (request: Request): string =>
  `http://${request.headers.get("host") ?? new URL(request.url).host}`

/** A request from a page on this same origin: its Origin names the Host it was sent to. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  const host = request.headers.get("host")
  if (origin === null || host === null) return false
  const site = request.headers.get("sec-fetch-site")
  if (site !== null && site !== "same-origin") return false
  try {
    const url = new URL(origin)
    return url.protocol === "http:" && url.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/** The body as text, or undefined once it passes `max` bytes (declared or actual). */
async function readCapped(request: Request, max: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > max) return undefined
  if (request.body === null) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** Create the session a dev server owns from construction to `stop()`. */
export function createDevSession(options: DevSessionOptions): DevSession {
  const { root, pipeline } = options
  const record = options.record !== false
  const indicator = options.indicator !== false
  const feed = createDevFeed({
    root,
    persist: record,
    showSource: createSourceGate(root),
    publicEnvPrefix: options.publicEnvPrefix,
  })
  const token = createDevToken()
  // Embedded in every page, so it proves only "a page this server served": it admits event batches
  // and nothing else. The agent token never leaves the discovery record.
  const pageToken = createDevToken()
  const startedAt = new Date().toISOString()
  let port = 0
  let requestCounter = 0
  let stopped = false

  const diagnostics = createDevDiagnostics(root, (err, request) => {
    const entry = feed.recordError(err, { category: "ssr", request })
    return {
      diagnostic: entry.diagnostic,
      entry: { id: entry.id, seq: entry.seq },
      requestId: entry.requestId,
      category: entry.category,
    }
  })

  const detachCapture = captureInto(feed)
  const mapper = createSourceMapper({
    root,
    origin: () => (port === 0 ? undefined : `http://127.0.0.1:${port}`),
  })

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
    if (path === DEV_FEED_PATHS.indicator) {
      if (!indicator) return json({ code: "NIFRA_DEV_NOT_FOUND", message: "indicator off" }, 404)
      return new Response(DEV_INDICATOR_SOURCE, { headers: INDICATOR_HEADERS })
    }
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

  // A page can loop on an error (a render that throws every frame): the bucket keeps it from flooding
  // the feed. Refills at 30 events a second, holds 300.
  const bucket = { tokens: 300, at: performance.now() }
  let lastDropNotice = Number.NEGATIVE_INFINITY
  const admit = (wanted: number): number => {
    const now = performance.now()
    bucket.tokens = Math.min(300, bucket.tokens + ((now - bucket.at) / 1000) * 30)
    bucket.at = now
    const granted = Math.min(wanted, Math.floor(bucket.tokens))
    bucket.tokens -= granted
    return granted
  }

  /** A browser error as an entry, its stack mapped back to source. */
  const recordBrowserError = async (
    error: BrowserError,
    meta: LogMeta,
  ): Promise<{ readonly head: string; readonly entry: DevErrorEntry }> => {
    const head = `${error.name}: ${error.message}`
    // Chrome leads a stack with its message; Firefox and Safari send frames only. Rebuild one shape.
    const mapped = error.stack === "" ? "" : await mapper.mapStack(error.stack)
    const frames = mapped
      .split("\n")
      .filter((line) => /^\s*at\s/.test(line))
      .join("\n")
    const rebuilt = new Error(error.message)
    rebuilt.name = error.name
    rebuilt.stack = frames === "" ? head : `${head}\n${frames}`
    const entry = feed.recordError(rebuilt, {
      ...meta,
      category: isHydrationMismatch(error.message) ? "hydration" : "browser",
    })
    return { head, entry }
  }

  /** Record one browser event; returns the error entry it produced, if any. */
  const recordClientEvent = async (event: ClientEvent): Promise<DevErrorEntry | undefined> => {
    const meta: LogMeta = { source: "browser", page: event.page, requestId: event.requestId }
    if (event.kind === "console") {
      feed.recordLog(event.level, event.message, meta)
      if (event.error !== undefined) return (await recordBrowserError(event.error, meta)).entry
      // React 18, Vue and Svelte report a mismatch through the console rather than by throwing.
      if (
        (event.level === "error" || event.level === "warn") &&
        isHydrationMismatch(event.message)
      ) {
        const recorded = await recordBrowserError(
          { name: "HydrationMismatch", message: event.message, stack: "" },
          meta,
        )
        return recorded.entry
      }
      return undefined
    }
    if (event.kind === "resource") {
      const { head, entry } = await recordBrowserError(
        { name: "ResourceError", message: `failed to load <${event.tag}> ${event.url}`, stack: "" },
        meta,
      )
      feed.recordLog("error", head, meta)
      return entry
    }
    const { head, entry } = await recordBrowserError(event, meta)
    feed.recordLog(
      "error",
      `Uncaught ${event.kind === "rejection" ? "(in promise) " : ""}${head}`,
      meta,
    )
    return entry
  }

  /** What the indicator shows for an entry: the redacted diagnostic, paths relative, and prompts. */
  const issueOf = (entry: DevErrorEntry): DevIssue => {
    const { diagnostic } = entry
    const top = diagnostic.codeframe ?? diagnostic.frames.find((f) => f.file !== undefined)
    return {
      id: entry.id,
      seq: entry.seq,
      count: entry.count,
      code: diagnostic.code,
      category: entry.category,
      message: diagnosticHeadline(diagnostic).slice(0, 2000),
      page: entry.page,
      at:
        top?.file === undefined
          ? undefined
          : `${promptPath(top.file, root)}:${top.line ?? 0}${top.column === undefined ? "" : `:${top.column}`}`,
      codeframe:
        diagnostic.codeframe === undefined ? undefined : { lines: diagnostic.codeframe.lines },
      cause: diagnostic.cause,
      fix: diagnostic.fix,
      docs:
        diagnostic.docsAnchor === undefined
          ? undefined
          : `https://nifra.dev/docs/${diagnostic.docsAnchor}`,
      prompts: fixPrompts(diagnostic, {
        surface: "indicator",
        root,
        entry: { id: entry.id, seq: entry.seq },
        requestId: entry.requestId,
        page: entry.page,
        category: entry.category,
      }),
    }
  }

  const ingestClientEvents = async (request: Request): Promise<Response> => {
    if (request.method !== "POST")
      return json({ code: "NIFRA_DEV_METHOD", message: "use POST" }, 405)
    // Only this server's own pages: a cross-site form or `fetch` POST carries a foreign Origin.
    if (!sameOrigin(request))
      return json({ code: "NIFRA_DEV_FORBIDDEN", message: "same-origin pages only" }, 403)
    const text = await readCapped(request, CLIENT_BATCH_MAX_BYTES)
    if (text === undefined)
      return json({ code: "NIFRA_DEV_TOO_LARGE", message: "batch too large" }, 413)
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return json({ code: "NIFRA_DEV_BAD_BATCH", message: "batch is not JSON" }, 400)
    }
    const batch = parseClientBatch(value)
    if (batch === undefined)
      return json({ code: "NIFRA_DEV_BAD_BATCH", message: "batch has the wrong shape" }, 400)
    if (!timingSafeEqual(batch.token, pageToken))
      return json({ code: "NIFRA_DEV_UNAUTHORIZED", message: "unknown page token" }, 401)
    const granted = admit(batch.events.length)
    const recorded: DevErrorEntry[] = []
    for (const event of batch.events.slice(0, granted)) {
      const entry = await recordClientEvent(event)
      if (entry !== undefined) recorded.push(entry)
    }
    if (granted < batch.events.length) {
      const now = performance.now()
      if (now - lastDropNotice > 10_000) {
        lastDropNotice = now
        feed.recordLog(
          "warn",
          "[nifra] the browser is reporting faster than 30 events a second; dropping the excess",
        )
      }
      return json({ code: "NIFRA_DEV_RATE_LIMITED", message: "slow down" }, 429)
    }
    // The page gets back only what it just reported, so this answer reveals nothing it did not send.
    if (indicator && recorded.length > 0) {
      return json({ issues: recorded.slice(-DEV_INDICATOR_MAX_ISSUES).map(issueOf) })
    }
    return new Response(null, { status: 204, headers: { [DEV_FEED_HEADER]: "true" } })
  }

  const clientConfig = (
    request: Request,
    requestId: string | null | undefined,
  ): DevClientConfig => {
    const url = new URL(request.url)
    return {
      ingestPath: DEV_FEED_PATHS.clientEvent,
      pageToken,
      indicatorPath: indicator ? DEV_FEED_PATHS.indicator : undefined,
      requestId: requestId ?? undefined,
      documentPath: `${url.pathname}${url.search}`,
    }
  }

  const decoratePage = (request: Request, response: Response): Response => {
    const body = response.body
    if (body === null || !isInjectablePage(response, request.method)) return response
    const headers = new Headers(response.headers)
    const requestId = currentDevRequest()?.requestId ?? response.headers.get(DEV_REQUEST_ID_HEADER)
    const tag = devClientTag(clientConfig(request, requestId), headers, originOf(request))
    if (tag === undefined) return response
    headers.delete("content-length") // the body grows by the script
    return new Response(injectIntoStream(body, tag), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  const decorateHtml = (
    request: Request,
    html: string,
    headers: Headers,
    requestId?: string | null,
  ): string => {
    const tag = devClientTag(clientConfig(request, requestId), headers, originOf(request), true)
    return tag === undefined ? html : injectIntoHtml(html, tag)
  }

  const isDocumentRequest = (request: Request): boolean => {
    if (request.method !== "GET" && request.method !== "HEAD") return false
    if (request.headers.has(DATA_HEADER)) return false
    const dest = request.headers.get("sec-fetch-dest")
    if (dest !== null) return dest === "document" || dest === "iframe"
    return (request.headers.get("accept") ?? "").includes("text/html")
  }

  const overlays = new WeakSet<Response>()
  // Core answers a page render that throws with a bare JSON 500, and its log line has already put the
  // error in the feed under this request. A browser loading that page gets the overlay for it instead.
  const overlayFor = async (
    request: Request,
    requestId: string,
    response: Response,
  ): Promise<Response | undefined> => {
    if (response.status < 500 || !isDocumentRequest(request)) return undefined
    if ((response.headers.get("content-type") ?? "").includes("text/html")) return undefined
    const entry = feed.errors({ requestId }).errors.at(-1)
    if (entry === undefined) return undefined
    await response.body?.cancel()
    const html = diagnostics.show({
      diagnostic: entry.diagnostic,
      entry: { id: entry.id, seq: entry.seq },
      requestId,
      category: entry.category,
    })
    const overlay = new Response(html, {
      status: response.status,
      headers: { "content-type": "text/html; charset=utf-8" },
    })
    overlays.add(overlay)
    return overlay
  }

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
    response = (await overlayFor(request, requestId, response)) ?? response
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
    isOverlay: (response) => overlays.has(response),
    decoratePage,
    decorateHtml,
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
    markChange: () => {
      feed.markChange()
      mapper.clear()
    },
    listening: (bound) => {
      port = bound
      if (!record) return
      try {
        writeDevServerRecord(root, {
          schema: DEV_FEED_SCHEMA,
          pid: process.pid,
          port: bound,
          url: `http://127.0.0.1:${bound}`,
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
