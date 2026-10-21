import type {
  BoundaryError,
  BoundaryRequestCtx,
  BoundaryState,
  BoundaryStates,
} from "../../boundary.ts"
import { type CspPolicy, cspHeaderWithSources, prepareCspPolicy } from "../../csp.ts"
import { defer } from "../../deferred.ts"
import type { RenderAdapter } from "../../render-seam.ts"
import { isControlFlow, isStatusSignal } from "../render-document.ts"
import { HoleAdmission, type HoleRun, type HoleSlot, watchAbort } from "./admission.ts"
import type { ShellCheckRecord } from "./compile-shell.ts"
import {
  type HoleRegistration,
  type PprRequest,
  type PprServer,
  PprShellBusy,
  PprShellUnchecked,
  variationQuery,
} from "./contract.ts"
import {
  assertHoleName,
  encodeHoleFrame,
  injectHoleFallbacks,
  requestScriptAround,
  validateHoleHtml,
} from "./frames.ts"
import { type ResolvedPprOptions, totalDeadlineMs } from "./options.ts"
import { PPR_BOOT, PPR_RUNTIME, pprScriptHashes } from "./runtime.ts"

export {
  type HoleRegistration,
  type HoleStatesMode,
  PPR_CANCEL_PATH,
  PPR_SERVER,
  type PprRequest,
  type PprServer,
  type PprServerStats,
  PprShellBusy,
  PprShellUnavailable,
  PprShellUnchecked,
  variationQuery,
} from "./contract.ts"

/** The error slot a failed, timed-out or refused hole shows. Constant: no thrown message reaches it. */
const HOLE_ERROR_HTML = '<p data-nifra-hole-error="">This section is unavailable.</p>'

/** The redacted state a blocking render shows for a hole that did not load, as `boundary.ts` does. */
const HOLE_ERROR_STATE: BoundaryError = { name: "Error", message: "Boundary failed" }

const DOCUMENT_END = "</body></html>"

const MODULE_SCRIPT = /<script type="module" src="([^"]*)"><\/script>/g

/** A built shell, shared by every visitor whose request maps to its key. */
const NO_BYTES = new Uint8Array(0)

interface ShellEntry {
  readonly routeId: string
  /**
   * The document up to (not including) `</body></html>` and the request script up to its token,
   * encoded once: the token, the rest of the script ({@link requestTail}) and the holes follow.
   */
  readonly prefix: Uint8Array
  readonly requestTail: Uint8Array
  /** The shell loader's output, for a soft navigation's data request. */
  readonly data: unknown
  readonly bytes: number
  readonly builtAt: number
  readonly tags: readonly string[]
  /** The shell loader's `notFound()`, rethrown for every request until the entry expires. */
  readonly notFound?: unknown
  /** Background rebuilds that failed in a row; the next waits `2 ** failures` seconds. */
  failures: number
  retryAt: number
}

export interface PprServerConfig {
  readonly options: ResolvedPprOptions
  readonly adapter: RenderAdapter
  readonly csp?: CspPolicy
  /** Part of every shell key, so a shell built by one deployment is never served by another. */
  readonly deployment: string
  readonly cancelUrl: string
  /**
   * The routes whose shell import check passed, for this deployment. A route not listed, or a record
   * made for another deployment, gets no shared shell (fail closed). `"unchecked-development"` waives
   * the check and is refused in production.
   */
  readonly shellChecks: ShellCheckRecord | "unchecked-development"
  /** Milliseconds, for shell freshness. Tests pass their own clock. */
  readonly now?: () => number
}

interface HoleStart {
  readonly hole: HoleRegistration
  readonly run: Promise<HoleRun<unknown>>
}

/** One streamed response's own queue of frames its client has not read yet. */
interface StreamState {
  readonly queue: Uint8Array[]
  queued: number
  overflowed: boolean
  ending: boolean
  dead: boolean
  wake: (() => void) | undefined
  kill(reason: unknown): void
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
  `ppr:v1|${deployment}|${request.routeId}|${request.locale ?? ""}|${request.path}|${variationQuery(request.variations)}`

const isProduction = (): boolean =>
  typeof process !== "undefined" && process.env?.NODE_ENV === "production"

const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

/** A fresh frozen context per invocation, so no hole sees or changes a sibling's. */
const holeCtx = (
  context: Omit<BoundaryRequestCtx, "signal">,
  signal: AbortSignal,
): BoundaryRequestCtx =>
  Object.freeze({
    request: context.request,
    params: Object.freeze({ ...context.params }),
    api: context.api,
    env: context.env,
    draft: context.draft,
    search: Object.freeze({ ...context.search }),
    signal,
  })

interface HoleDeadline {
  readonly signal: AbortSignal
  /** One of the holes settled; the last one clears the timer. */
  leave(): void
}

interface HoleDeadlines {
  join(timeoutMs: number): HoleDeadline
}

/**
 * Holes that start together with one timeout share its signal and timer: a controller, listener and
 * timer per hole cost more under load than the holes. Not `AbortSignal.timeout`: its timer stays
 * pending after the holes settle.
 */
const holeDeadlines = (response: AbortSignal): HoleDeadlines => {
  const byTimeout = new Map<number, HoleDeadline & { joined: number }>()
  return {
    join(timeoutMs) {
      let deadline = byTimeout.get(timeoutMs)
      if (deadline === undefined) {
        const own = new AbortController()
        if (response.aborted) own.abort(response.reason)
        else watchAbort(response, () => own.abort(response.reason))
        const timer = setTimeout(
          () => own.abort(new DOMException("The operation timed out.", "TimeoutError")),
          timeoutMs,
        )
        const created = {
          signal: own.signal,
          joined: 0,
          leave() {
            if (--created.joined === 0) clearTimeout(timer)
          },
        }
        deadline = created
        byTimeout.set(timeoutMs, created)
      }
      deadline.joined++
      return deadline
    },
  }
}

// Error frames are a few hundred bytes whatever the hole, so no frame limit applies to them.
const errorFrame = (name: string): string =>
  encodeHoleFrame(name, { error: true, html: HOLE_ERROR_HTML }, Number.POSITIVE_INFINITY)

/**
 * WebKit paints a loading document only once it holds about this many characters of text, so a
 * sparser shell shows nothing in Safari until its slowest hole ends (measured in WebKit 2026-10: a
 * 171-character paragraph stayed blank, 228 painted at once). Fewer than this never paints early.
 */
const WEBKIT_PAINT_CHARS = 200

const SKIPPED_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "template", "noscript"])

/** Characters of text in `html` with whitespace collapsed, outside tags, comments and scripts.
 * An `indexOf` scan, not a lazy regex, so an unclosed opener stays linear. */
const textLength = (html: string): number => {
  let count = 0
  let blank = true
  let at = 0
  while (at < html.length) {
    const open = html.indexOf("<", at)
    const end = open === -1 ? html.length : open
    for (let i = at; i < end; i++) {
      const code = html.charCodeAt(i)
      const space = code === 32 || (code >= 9 && code <= 13)
      if (!space || !blank) count++
      blank = space
    }
    if (open === -1) break
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4)
      at = close === -1 ? html.length : close + 3
      continue
    }
    const close = html.indexOf(">", open)
    if (close === -1) break
    at = close + 1
    const name = /^<([a-zA-Z]+)/.exec(html.slice(open, open + 12))?.[1]?.toLowerCase()
    if (name !== undefined && SKIPPED_ELEMENTS.has(name)) {
      const endTag = html.indexOf(`</${name}`, at)
      at = endTag === -1 ? html.length : endTag
    }
  }
  return count
}

const SHED: HoleRun<never> = Object.freeze({ ok: false, reason: "denied" })

/** What a cached `notFound()` counts against the store's byte budget, beside its key. */
const NOT_FOUND_ENTRY_BYTES = 256

/** A 404 entry answers as the shell loader's own `notFound()` did. */
const served = (entry: ShellEntry): ShellEntry | Promise<never> =>
  entry.notFound === undefined ? entry : Promise.reject(entry.notFound)

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
  const now = config.now ?? Date.now
  // Captured outside any request, so an on-demand build sees no visitor's async context.
  const detached: <T>(fn: () => T) => T =
    globalThis.process?.getBuiltinModule?.("node:async_hooks")?.AsyncLocalStorage?.snapshot?.() ??
    ((fn) => fn())
  const settled = new Map<string, ShellEntry>()
  const routeCounts = new Map<string, number>()
  let storedBytes = 0
  const builds = new Map<string, Promise<ShellEntry>>()
  const buildsByRoute = new Map<string, number>()
  // A build records the count when it starts and is not stored if one of its tags was invalidated
  // since. Only running builds read the map, so it empties whenever none run.
  let invalidations = 0
  const invalidatedAt = new Map<string, number>()
  const live = new Map<string, AbortController>()
  const cspHeaders = new Map<string, Promise<string | undefined>>()
  const thinWarned = new Set<string>()
  const fallbackHtml = new WeakMap<HoleRegistration, Promise<string>>()

  // A fallback comes from its registration alone and every shell holds it, so it renders once.
  const fallbackOf = (hole: HoleRegistration): Promise<string> => {
    let html = fallbackHtml.get(hole)
    if (html === undefined) {
      const fallback = hole.fallback
      html =
        fallback === undefined
          ? Promise.resolve("")
          : Promise.resolve().then(() => renderFragment.call(adapter, fallback, {}))
      fallbackHtml.set(hole, html)
      html.catch(() => fallbackHtml.delete(hole))
    }
    return html
  }
  const admission = new HoleAdmission(
    options,
    isProduction()
      ? undefined
      : (key, ms) =>
          console.warn(
            `[nifra/web] ppr: boundary "${key}" settled ${Math.round(ms)} ms after its abort; pass ctx.signal to the work its loader starts`,
          ),
  )
  const streams = new Set<StreamState>()
  let unsentBytes = 0
  let slowAborted = 0

  const evict = (key: string): void => {
    const entry = settled.get(key)
    if (entry === undefined) return
    settled.delete(key)
    storedBytes -= entry.bytes
    routeCounts.set(entry.routeId, (routeCounts.get(entry.routeId) ?? 1) - 1)
  }

  const store = (key: string, entry: ShellEntry): void => {
    evict(key)
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
    // A component that copied the nonce into the shell would hand it to every visitor.
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
      `${html.slice(0, headEnd)}<script>${PPR_RUNTIME}</script>${html.slice(headEnd, -DOCUMENT_END.length)}`.replace(
        MODULE_SCRIPT,
        `<link rel="modulepreload" href="$1"><script>${PPR_BOOT}</script>`,
      )
    const fallbacks = new Map<string, string>()
    for (const hole of request.holes) fallbacks.set(hole.name, await fallbackOf(hole))
    prefix = injectHoleFallbacks(prefix, fallbacks)
    if (!isProduction() && !thinWarned.has(request.routeId)) {
      const text = textLength(prefix.slice(Math.max(prefix.indexOf("<body"), 0)))
      if (text < WEBKIT_PAINT_CHARS) {
        thinWarned.add(request.routeId)
        console.warn(
          `[nifra/web] ppr: the shell of "${request.routeId}" has ${text} characters of text. Safari paints a loading document only once it holds about ${WEBKIT_PAINT_CHARS}, so it shows this page only when its slowest hole ends`,
        )
      }
    }
    const encoder = new TextEncoder()
    const [beforeToken, afterToken] = requestScriptAround(
      cancelUrl,
      request.holes.map((hole) => hole.name),
    )
    let bytes = encoder.encode(prefix + beforeToken)
    const short = options.minShellBytes - (bytes.length - encoder.encode(beforeToken).length)
    if (short > 0) bytes = encoder.encode(`${prefix}<!--${" ".repeat(short)}-->${beforeToken}`)
    const requestTail = encoder.encode(afterToken)
    return {
      routeId: request.routeId,
      prefix: bytes,
      requestTail,
      data,
      bytes: bytes.length + requestTail.length,
      builtAt: now(),
      tags: request.tags(),
      failures: 0,
      retryAt: 0,
    }
  }

  const startBuild = (key: string, request: PprRequest): Promise<ShellEntry> => {
    const routeId = request.routeId
    buildsByRoute.set(routeId, (buildsByRoute.get(routeId) ?? 0) + 1)
    const startedAt = invalidations
    // Not `AbortSignal.timeout`: under a run of misses its timers would stay pending long after the
    // builds settle.
    const timeout = new AbortController()
    const signal = timeout.signal
    const timer = setTimeout(
      () => timeout.abort(new DOMException("The operation timed out.", "TimeoutError")),
      options.maxHoleTimeoutMs,
    )
    const building = detached(() =>
      request.loadShell(signal).then(
        async (data) =>
          finishShell(
            await request.renderShellDocument(data, pendingStates(request.holes)),
            request,
            data,
          ),
        (error: unknown): ShellEntry => {
          // A missing record is cached briefly, so a flood of unknown ids runs no loader twice.
          if (!isStatusSignal(error) || error.status !== 404) throw error
          return {
            routeId,
            prefix: NO_BYTES,
            requestTail: NO_BYTES,
            data: undefined,
            bytes: NOT_FOUND_ENTRY_BYTES + key.length,
            builtAt: now(),
            tags: request.tags(),
            notFound: error,
            failures: 0,
            retryAt: 0,
          }
        },
      ),
    )
    builds.set(key, building)
    const done = (): void => {
      clearTimeout(timer)
      builds.delete(key)
      const running = (buildsByRoute.get(routeId) ?? 1) - 1
      if (running === 0) buildsByRoute.delete(routeId)
      else buildsByRoute.set(routeId, running)
      if (builds.size === 0) invalidatedAt.clear()
    }
    building.then((entry) => {
      const fenced = entry.tags.some((tag) => (invalidatedAt.get(tag) ?? -1) > startedAt)
      done()
      if (!fenced) store(key, entry)
    }, done)
    return building
  }

  /** Behind a stale shell: one rebuild per key, within the route's build limit, backing off on failure. */
  const rebuild = (key: string, request: PprRequest, stale: ShellEntry): void => {
    if (builds.has(key) || now() < stale.retryAt) return
    if ((buildsByRoute.get(request.routeId) ?? 0) >= options.shellBuildConcurrency) return
    startBuild(key, request).catch((error: unknown) => {
      stale.failures++
      stale.retryAt = now() + Math.min(2 ** stale.failures, request.revalidate ?? 1) * 1000
      console.error("[nifra/web] ppr: shell rebuild failed; serving the stale shell", {
        route: request.routeId,
        kind: error instanceof Error ? "error" : typeof error,
      })
    })
  }

  const staleLimitMs = (revalidate: number): number =>
    (revalidate +
      Math.min(revalidate * options.staleOnErrorFactor, options.maxStaleOnErrorSeconds)) *
    1000

  const shellFor = (request: PprRequest): Promise<ShellEntry> => {
    const key = shellKey(deployment, request)
    const entry = settled.get(key)
    if (entry !== undefined) {
      settled.delete(key)
      settled.set(key, entry)
      const age = now() - entry.builtAt
      if (entry.notFound !== undefined) {
        if (age < options.notFoundTtlSeconds * 1000) return Promise.reject(entry.notFound)
      } else if (request.revalidate === undefined || age < request.revalidate * 1000) {
        return Promise.resolve(entry)
      } else if (age < staleLimitMs(request.revalidate)) {
        rebuild(key, request, entry)
        return Promise.resolve(entry)
      }
      evict(key)
    }
    const running = builds.get(key)
    if (running !== undefined) return running.then(served)
    if (!checked(request.routeId)) return Promise.reject(new PprShellUnchecked(request.routeId))
    if ((buildsByRoute.get(request.routeId) ?? 0) >= options.shellBuildConcurrency) {
      return Promise.reject(new PprShellBusy(request.routeId))
    }
    for (const hole of request.holes) assertHoleName(hole.name)
    return startBuild(key, request).then(served)
  }

  // The log carries the failure's kind only: a thrown message can hold credentials or user data.
  const logFailure = (request: PprRequest, hole: HoleRegistration, error: unknown): void =>
    console.error("[nifra/web] ppr: hole failed", {
      route: request.routeId,
      hole: hole.name,
      kind: error instanceof Error ? "error" : typeof error,
    })

  /** Invoke one hole loader under admission, with its timeout's deadline under the response. */
  const runHole = (
    slot: HoleSlot | undefined,
    request: PprRequest,
    hole: HoleRegistration,
    deadlines: HoleDeadlines,
  ): Promise<HoleRun<unknown>> => {
    const load = hole.load
    if (load === undefined) return Promise.resolve({ ok: true, value: undefined })
    if (slot === undefined) return Promise.resolve(SHED)
    const deadline = deadlines.join(hole.timeout ?? options.holeTimeoutMs)
    const signal = deadline.signal
    return slot
      .run(`${request.routeId}|${hole.name}`, signal, () =>
        load(holeCtx(request.holeContext, signal)),
      )
      .then((run) => {
        deadline.leave()
        // The shell's status and headers are already sent, so a hole has no redirect or status to give.
        const settled: HoleRun<unknown> =
          run.ok && (isControlFlow(run.value) || isStatusSignal(run.value))
            ? { ok: false, reason: "failed", error: new TypeError("returned a redirect or status") }
            : run
        if (!settled.ok && settled.reason === "failed") logFailure(request, hole, settled.error)
        return settled
      })
  }

  /** Start every hole of one response. No free slot: none is invoked and each gets its error. */
  const startHoles = (request: PprRequest, response: AbortSignal): HoleStart[] => {
    const slot = admission.slot()
    const deadlines = holeDeadlines(response)
    const runs = request.holes.map((hole) => ({
      hole,
      run: runHole(slot, request, hole, deadlines),
    }))
    slot?.seal()
    return runs
  }

  const frameOf = async (
    request: PprRequest,
    hole: HoleRegistration,
    run: HoleRun<unknown>,
  ): Promise<string> => {
    if (!run.ok) return errorFrame(hole.name)
    try {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: defineBoundary binds render to its own load's output; the registration erases that generic, and the value came from that load.
      const ui = hole.render(run.value as never)
      const html = await renderFragment.call(adapter, ui, { idPrefix: `nifra-${hole.name}-` })
      if (options.holeHtmlValidation === "always" || !isProduction()) validateHoleHtml(html)
      return encodeHoleFrame(
        hole.name,
        hole.interactive === true ? { html, props: run.value } : { html },
        options.frameBytes,
      )
    } catch (error) {
      logFailure(request, hole, error)
      return errorFrame(hole.name)
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

  const documentHeaders = (csp: string | undefined): Record<string, string> => {
    const headers: Record<string, string> = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "x-accel-buffering": "no",
    }
    if (csp !== undefined) headers["content-security-policy"] = csp
    return headers
  }

  /** Abort the streams with the most unsent bytes until `bytes` more fit the process budget. */
  const makeRoom = (bytes: number): void => {
    while (unsentBytes + bytes > options.maxUnsentBytes) {
      let largest: StreamState | undefined
      for (const stream of streams)
        if (largest === undefined || stream.queued > largest.queued) largest = stream
      if (largest === undefined || largest.queued === 0) return
      slowAborted++
      largest.kill(new DOMException("PPR unsent byte budget", "AbortError"))
    }
  }

  return {
    async respond(request) {
      if (request.request.method === "HEAD") {
        const [, csp] = await Promise.all([shellFor(request), cspHeader(request)])
        return new Response(null, { status: 200, headers: documentHeaders(csp) })
      }
      const controller = new AbortController()
      const unwatchDisconnect = watchAbort(request.request.signal, () =>
        controller.abort(request.request.signal.reason),
      )
      const deadlineMs = totalDeadlineMs(
        options,
        request.holes.map((hole) => hole.timeout ?? options.holeTimeoutMs),
      )
      const deadline = setTimeout(
        () => controller.abort(new DOMException("PPR total deadline", "TimeoutError")),
        deadlineMs,
      )
      const token = randomToken()
      live.set(token, controller)
      // Any abort (disconnect, deadline, cancel) retires the token at once, not when frames settle.
      watchAbort(controller.signal, () => live.delete(token))
      let lifetime: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        clearTimeout(deadline)
        clearTimeout(lifetime)
        live.delete(token)
        unwatchDisconnect()
      }
      // A cached shell is known at once, so holes start only once it is known to be a page; on a
      // miss they start beside the build, which is where starting early pays.
      const cached = settled.has(shellKey(deployment, request))
      let runs = cached ? undefined : startHoles(request, controller.signal)
      let shell: ShellEntry
      let csp: string | undefined
      try {
        ;[shell, csp] = await Promise.all([shellFor(request), cspHeader(request)])
      } catch (error) {
        controller.abort(error)
        cleanup()
        throw error
      }
      runs ??= startHoles(request, controller.signal)

      const encoder = new TextEncoder()
      let sink: ReadableStreamDefaultController<Uint8Array> | undefined
      const state: StreamState = {
        queue: [],
        queued: 0,
        overflowed: false,
        ending: false,
        dead: false,
        wake: undefined,
        kill(reason) {
          if (state.dead) return
          state.dead = true
          unsentBytes -= state.queued
          state.queued = 0
          state.queue.length = 0
          streams.delete(state)
          controller.abort(reason)
          cleanup()
          try {
            sink?.error(reason)
          } catch {
            // Already closed or cancelled by the reader: nothing left to error.
          }
          state.wake?.()
        },
      }
      const wake = (): void => {
        const resume = state.wake
        state.wake = undefined
        resume?.()
      }
      const push = (name: string, frame: string): void => {
        if (state.dead) return
        let bytes = encoder.encode(frame)
        // Past the per-response cap every later hole sends its error frame, a few hundred bytes each.
        if (state.overflowed || state.queued + bytes.length > options.maxUnsentBytesPerResponse) {
          state.overflowed = true
          bytes = encoder.encode(errorFrame(name))
        }
        makeRoom(bytes.length)
        if (state.dead) return
        state.queue.push(bytes)
        state.queued += bytes.length
        unsentBytes += bytes.length
        wake()
      }
      streams.add(state)
      lifetime = setTimeout(
        () => state.kill(new DOMException("PPR write grace", "TimeoutError")),
        deadlineMs + options.writeGraceMs,
      )
      void Promise.all(
        runs.map(({ hole, run }) =>
          run
            .then((outcome) => frameOf(request, hole, outcome))
            .then((frame) => push(hole.name, frame)),
        ),
      ).then(() => {
        if (state.dead) return
        const end = encoder.encode(DOCUMENT_END)
        state.queue.push(end)
        state.queued += end.length
        unsentBytes += end.length
        state.ending = true
        wake()
      })

      const body = new ReadableStream<Uint8Array>(
        {
          start(stream) {
            sink = stream
            // A copy: a reader may write into a chunk, and the shell's bytes serve every visitor.
            const first = new Uint8Array(
              shell.prefix.length + token.length + shell.requestTail.length,
            )
            first.set(shell.prefix)
            encoder.encodeInto(token, first.subarray(shell.prefix.length))
            first.set(shell.requestTail, shell.prefix.length + token.length)
            stream.enqueue(first)
          },
          // Pulled only when the reader wants bytes, so unread frames stay counted in `state.queue`.
          async pull(stream) {
            while (state.queue.length === 0 && !state.ending && !state.dead) {
              await new Promise<void>((resolve) => {
                state.wake = resolve
              })
            }
            if (state.dead) return
            const chunk = state.queue.shift()
            if (chunk !== undefined) {
              state.queued -= chunk.length
              unsentBytes -= chunk.length
              stream.enqueue(chunk)
            }
            if (state.queue.length === 0 && state.ending) {
              state.dead = true
              streams.delete(state)
              stream.close()
              cleanup()
            }
          },
          cancel(reason) {
            state.kill(reason)
          },
        },
        { highWaterMark: 0 },
      )
      return new Response(body, { status: 200, headers: documentHeaders(csp) })
    },

    async shellData(request) {
      return (await shellFor(request)).data
    },

    async holeStates(request, mode, signal) {
      if (mode === "omitted") return pendingStates(request.holes)
      const entries = await Promise.all(
        startHoles(request, signal).map(async ({ hole, run }): Promise<[string, BoundaryState]> => {
          const base: BoundaryState = { name: hole.name, mode: hole.mode, status: "pending" }
          if (hole.errorId !== undefined) Object.assign(base, { errorId: hole.errorId })
          if (mode === "deferred") {
            const value = run.then((outcome) => {
              if (outcome.ok) return outcome.value
              // The request's own abort reason, so the stream sees a client that left, not a failure.
              throw signal.aborted
                ? signal.reason
                : new Error(`[nifra/web] ppr: hole "${hole.name}" is unavailable`)
            })
            return [hole.name, { ...base, data: defer(value) }]
          }
          const outcome = await run
          if (!outcome.ok) return [hole.name, { ...base, status: "error", error: HOLE_ERROR_STATE }]
          return [
            hole.name,
            outcome.value === undefined
              ? { ...base, status: "ready" }
              : { ...base, status: "ready", data: outcome.value },
          ]
        }),
      )
      return Object.fromEntries(entries)
    },

    invalidateTag(tag) {
      invalidations++
      if (builds.size > 0) invalidatedAt.set(tag, invalidations)
      for (const [key, entry] of settled) if (entry.tags.includes(tag)) evict(key)
    },

    cancel(token) {
      const controller = live.get(token)
      if (controller === undefined) return false
      live.delete(token)
      controller.abort(new DOMException("PPR cancelled by the client", "AbortError"))
      return true
    },

    stats() {
      return { ...admission.stats(), slowAborted, unsentBytes }
    },
  }
}
