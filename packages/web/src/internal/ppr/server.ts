import type {
  BoundaryRegistration,
  BoundaryRequestCtx,
  BoundaryState,
  BoundaryStates,
} from "../../boundary.ts"
import { type CspPolicy, cspHeaderWithSources, prepareCspPolicy } from "../../csp.ts"
import type { RenderAdapter } from "../../render-seam.ts"
import type { ShellCheckRecord } from "./compile-shell.ts"
import {
  assertHoleName,
  encodeHoleFrame,
  encodeRequestScript,
  injectHoleFallbacks,
  validateHoleHtml,
} from "./frames.ts"
import { type ResolvedPprOptions, totalDeadlineMs } from "./options.ts"
import { PPR_RUNTIME, pprScriptHashes } from "./runtime.ts"

/** Where the runtime's cancel beacon goes, under the app's base path. */
export const PPR_CANCEL_PATH = "/__nifra/ppr/cancel"

/** The error slot a failed, timed-out or refused hole shows. Constant: no thrown message reaches it. */
const HOLE_ERROR_HTML = '<p data-nifra-hole-error="">This section is unavailable.</p>'

const DOCUMENT_END = "</body></html>"

/** The boundary fields G6 reads beyond the neutral registration. */
export type HoleRegistration = Extract<BoundaryRegistration, { readonly mode: "dynamic" }> & {
  readonly interactive?: boolean
  readonly timeout?: number
}

/** A built shell, shared by every visitor whose request maps to its key. */
interface ShellEntry {
  readonly routeId: string
  /** The document up to (not including) `</body></html>`: holes stream after it. */
  readonly prefix: string
  /** The shell loader's output, for a soft navigation's data request. */
  readonly data: unknown
  readonly bytes: number
}

/** What the page executor hands over for one PPR request. */
export interface PprRequest {
  readonly routeId: string
  /** The request's pathname, without search: the shell renders it, so it is part of the key. */
  readonly path: string
  readonly locale: string | undefined
  readonly request: Request
  /** The route's dynamic boundaries, in declaration order, with their merged (guarded) loaders. */
  readonly holes: readonly HoleRegistration[]
  readonly holeContext: Omit<BoundaryRequestCtx, "signal">
  readonly loadShell: (signal: AbortSignal) => Promise<unknown>
  /** Render the full document for `shellData` with every hole pending, under no nonce. */
  readonly renderShellDocument: (shellData: unknown, states: BoundaryStates) => Promise<string>
}

export interface PprServerConfig {
  readonly options: ResolvedPprOptions
  readonly adapter: RenderAdapter
  readonly csp?: CspPolicy
  /** Part of every shell key, so a shell built by one deployment is never served by another (I11). */
  readonly deployment: string
  readonly cancelUrl: string
  /**
   * The routes whose shell import check passed, for this deployment. A route not listed, or a record
   * made for another deployment, gets no shared shell (fail closed). `"unchecked-development"` waives
   * the check and is refused in production.
   */
  readonly shellChecks: ShellCheckRecord | "unchecked-development"
}

/** Thrown when a route's shell has no passing import-check record: the caller renders it blocking. */
export class PprShellUnchecked extends Error {
  constructor(routeId: string) {
    super(
      `[nifra/web] ppr: route "${routeId}" has no passing shell import check; rendered blocking`,
    )
  }
}

export interface PprServer {
  /** Stream one PPR document: the shared shell at once, then each hole as it settles. */
  respond(request: PprRequest): Promise<Response>
  /** The shell data a soft navigation's data request carries. */
  shellData(request: PprRequest): Promise<unknown>
  /** Abort the response that printed `token`. Unknown tokens do nothing. */
  cancel(token: string): boolean
}

const pendingStates = (holes: readonly HoleRegistration[]): BoundaryStates => {
  const states: Record<string, BoundaryState & { readonly ppr: true }> = {}
  for (const hole of holes)
    states[hole.name] = { name: hole.name, mode: hole.mode, status: "pending", ppr: true }
  return states
}

// The pathname, not the matched params, keys the shell: two spellings of one path (percent-encoding)
// match the same params but render different `path`s. The per-route cap bounds the spellings.
const shellKey = (deployment: string, request: PprRequest): string =>
  `ppr:v1|${deployment}|${request.routeId}|${request.locale ?? ""}|${request.path}`

const isProduction = (): boolean =>
  typeof process !== "undefined" && process.env?.NODE_ENV === "production"

const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

/** Settles with `promise`, or rejects as soon as `signal` aborts: the response never waits on a
 * loader that ignores its signal (I7). */
const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  signal.aborted
    ? Promise.reject(signal.reason)
    : new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason)
        signal.addEventListener("abort", onAbort, { once: true })
        promise.then(
          (value) => {
            signal.removeEventListener("abort", onAbort)
            resolve(value)
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort)
            reject(error)
          },
        )
      })

export function createPprServer(config: PprServerConfig): PprServer {
  const { options, adapter, deployment, cancelUrl, shellChecks } = config
  const renderFragment = adapter.renderFragment
  if (renderFragment === undefined) {
    throw new TypeError("[nifra/web] ppr: the render adapter does not implement renderFragment")
  }
  if (shellChecks === "unchecked-development" && isProduction()) {
    throw new TypeError("[nifra/web] ppr: production needs the build's shell check records")
  }
  const checked = (routeId: string): boolean =>
    shellChecks === "unchecked-development" ||
    (shellChecks.deployment === deployment && Object.hasOwn(shellChecks.routes, routeId))
  const shells = new Map<string, Promise<ShellEntry>>()
  const settled = new Map<string, ShellEntry>()
  const routeCounts = new Map<string, number>()
  let storedBytes = 0
  const live = new Map<string, AbortController>()
  const cspHeaders = new Map<string, Promise<string | undefined>>()

  const evict = (key: string): void => {
    const entry = settled.get(key)
    shells.delete(key)
    if (entry === undefined) return
    settled.delete(key)
    storedBytes -= entry.bytes
    routeCounts.set(entry.routeId, (routeCounts.get(entry.routeId) ?? 1) - 1)
  }

  const store = (key: string, entry: ShellEntry): void => {
    settled.set(key, entry)
    storedBytes += entry.bytes
    routeCounts.set(entry.routeId, (routeCounts.get(entry.routeId) ?? 0) + 1)
    // Map order is insertion order, refreshed on every hit, so iteration meets the least recent first.
    // Over the byte budget anything older goes; over the route's entry cap, that route's oldest.
    for (const [oldKey, old] of settled) {
      const overBytes = storedBytes > options.shellStoreBytes
      const overRoute = (routeCounts.get(entry.routeId) ?? 0) > options.shellEntriesPerRoute
      if (!overBytes && !overRoute) break
      if (oldKey !== key && (overBytes || old.routeId === entry.routeId)) evict(oldKey)
    }
  }

  const finishShell = async (
    html: string,
    request: PprRequest,
    data: unknown,
  ): Promise<ShellEntry> => {
    // A component that copied the nonce into the shell would hand it to every visitor (I2).
    if (html.includes(" nonce=")) {
      throw new Error(`[nifra/web] ppr: route "${request.routeId}" rendered a nonce into its shell`)
    }
    if (!html.endsWith(DOCUMENT_END)) {
      throw new Error(`[nifra/web] ppr: route "${request.routeId}" shell does not end its document`)
    }
    const headEnd = html.indexOf("</head>")
    if (headEnd === -1)
      throw new Error(`[nifra/web] ppr: route "${request.routeId}" shell has no head`)
    // The client entry must not wait for the end of the document, which is the slowest hole.
    let prefix =
      `${html.slice(0, headEnd)}<script>${PPR_RUNTIME}</script>${html.slice(headEnd, -DOCUMENT_END.length)}`.replaceAll(
        '<script type="module" src="',
        '<script type="module" async src="',
      )
    const fallbacks = new Map<string, string>()
    for (const hole of request.holes) {
      fallbacks.set(
        hole.name,
        hole.fallback === undefined ? "" : await renderFragment.call(adapter, hole.fallback, {}),
      )
    }
    prefix = injectHoleFallbacks(prefix, fallbacks)
    const size = new TextEncoder().encode(prefix).length
    if (size < options.minShellBytes) prefix += `<!--${" ".repeat(options.minShellBytes - size)}-->`
    return { routeId: request.routeId, prefix, data, bytes: Math.max(size, options.minShellBytes) }
  }

  const shellFor = (request: PprRequest): Promise<ShellEntry> => {
    const key = shellKey(deployment, request)
    const known = shells.get(key)
    if (known !== undefined) {
      const entry = settled.get(key)
      if (entry !== undefined) {
        settled.delete(key)
        settled.set(key, entry)
      }
      return known
    }
    if (!checked(request.routeId)) return Promise.reject(new PprShellUnchecked(request.routeId))
    for (const hole of request.holes) assertHoleName(hole.name)
    const signal = AbortSignal.timeout(options.maxHoleTimeoutMs)
    const building = request
      .loadShell(signal)
      .then(async (data) =>
        finishShell(
          await request.renderShellDocument(data, pendingStates(request.holes)),
          request,
          data,
        ),
      )
    shells.set(key, building)
    building.then(
      (entry) => store(key, entry),
      () => shells.delete(key),
    )
    return building
  }

  const frameFor = async (
    hole: HoleRegistration,
    context: Omit<BoundaryRequestCtx, "signal">,
    response: AbortSignal,
  ): Promise<string> => {
    const timeout = hole.timeout ?? options.holeTimeoutMs
    const signal = AbortSignal.any([response, AbortSignal.timeout(timeout)])
    try {
      const load = hole.load
      const data =
        load === undefined
          ? undefined
          : await raceAbort(
              Promise.resolve().then(() => load({ ...context, signal })),
              signal,
            )
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: defineBoundary binds render to its own load's output; the registration erases that generic, and `data` came from that load.
      const ui = hole.render(data as never)
      const html = await renderFragment.call(adapter, ui, {
        idPrefix: `nifra-${hole.name}-`,
      })
      if (options.holeHtmlValidation === "always" || !isProduction()) {
        validateHoleHtml(html)
      }
      return encodeHoleFrame(
        hole.name,
        hole.interactive === true ? { html, props: data } : { html },
        options.frameBytes,
      )
    } catch (error) {
      // A disconnect or cancel is not a failure worth an error line; a timeout or a throw is.
      if (!response.aborted) console.error(`[nifra/web] ppr: hole "${hole.name}" failed`, error)
      return encodeHoleFrame(hole.name, { error: true, html: HOLE_ERROR_HTML }, options.frameBytes)
    }
  }

  const cspHeader = (request: PprRequest): Promise<string | undefined> => {
    const policy = config.csp
    if (policy === undefined) return Promise.resolve(undefined)
    let header = cspHeaders.get(request.routeId)
    if (header === undefined) {
      header = Promise.resolve(prepareCspPolicy(policy, adapter))
        .then(() => pprScriptHashes(request.holes.map((hole) => hole.name)))
        .then((hashes) => cspHeaderWithSources(policy, adapter, hashes.join(" ")))
      cspHeaders.set(request.routeId, header)
      header.catch(() => cspHeaders.delete(request.routeId))
    }
    return header
  }

  return {
    async respond(request) {
      const controller = new AbortController()
      const onDisconnect = (): void => controller.abort(request.request.signal.reason)
      request.request.signal.addEventListener("abort", onDisconnect, { once: true })
      const deadline = setTimeout(
        () => controller.abort(new DOMException("PPR total deadline", "TimeoutError")),
        totalDeadlineMs(
          options,
          request.holes.map((hole) => hole.timeout ?? options.holeTimeoutMs),
        ),
      )
      const token = randomToken()
      live.set(token, controller)
      // Any abort (disconnect, deadline, cancel) retires the token at once, not when frames settle.
      controller.signal.addEventListener("abort", () => live.delete(token), { once: true })
      const cleanup = (): void => {
        clearTimeout(deadline)
        live.delete(token)
        request.request.signal.removeEventListener("abort", onDisconnect)
      }
      const startHoles = (): Array<Promise<string>> =>
        request.holes.map((hole) => frameFor(hole, request.holeContext, controller.signal))
      // A cached shell is known at once, so holes start only once it is known to be a page; on a
      // miss they start beside the build, which is where starting early pays.
      const cached = settled.has(shellKey(deployment, request))
      let frames: Array<Promise<string>> | undefined = cached ? undefined : startHoles()
      let shell: ShellEntry
      let csp: string | undefined
      try {
        ;[shell, csp] = await Promise.all([shellFor(request), cspHeader(request)])
      } catch (error) {
        controller.abort(error)
        cleanup()
        throw error
      }
      frames ??= startHoles()
      const encoder = new TextEncoder()
      let closed = false
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(
            encoder.encode(
              shell.prefix +
                encodeRequestScript(
                  cancelUrl,
                  token,
                  request.holes.map((hole) => hole.name),
                ),
            ),
          )
          void Promise.all(
            (frames ?? []).map((frame) =>
              frame.then((html) => {
                if (!closed) stream.enqueue(encoder.encode(html))
              }),
            ),
          ).then(() => {
            if (closed) return
            closed = true
            stream.enqueue(encoder.encode(DOCUMENT_END))
            stream.close()
            cleanup()
          })
        },
        cancel(reason) {
          closed = true
          controller.abort(reason)
          cleanup()
        },
      })
      const headers: Record<string, string> = {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "x-accel-buffering": "no",
      }
      if (csp !== undefined) headers["content-security-policy"] = csp
      return new Response(body, { status: 200, headers })
    },

    async shellData(request) {
      return (await shellFor(request)).data
    },

    cancel(token) {
      const controller = live.get(token)
      if (controller === undefined) return false
      live.delete(token)
      controller.abort(new DOMException("PPR cancelled by the client", "AbortError"))
      return true
    },
  }
}
