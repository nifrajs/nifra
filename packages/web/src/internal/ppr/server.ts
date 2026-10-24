import { markRepeatedPrefix } from "@nifrajs/core/response-observer"
import type {
  BoundaryError,
  BoundaryRequestCtx,
  BoundaryState,
  BoundaryStates,
  SharedHoleCtx,
} from "../../boundary.ts"
import { type CspPolicy, cspHeaderWithSources, prepareCspPolicy } from "../../csp.ts"
import { defer } from "../../deferred.ts"
import type { RenderAdapter } from "../../render-seam.ts"
import { HOLE_ERROR_HTML } from "../hole-runtime.ts"
import { isControlFlow } from "../render-document.ts"
import { isStatusSignal, notFound } from "../status-page.ts"
import { HoleAdmission, type HoleRun, type HoleSlot, watchAbort } from "./admission.ts"
import type { ShellCheckRecord } from "./compile-shell.ts"
import {
  type HoleRegistration,
  type PprRequest,
  type PprServer,
  PprShellBusy,
  PprShellCold,
  PprShellUnchecked,
  type SharedHole,
  serverHoleComponent,
  variationQuery,
} from "./contract.ts"
import {
  assertHoleName,
  encodeHoleFrame,
  frameBodyOf,
  holeFallbackInserts,
  requestScriptAround,
  validateHoleHtml,
} from "./frames.ts"
import { type ResolvedPprOptions, totalDeadlineMs } from "./options.ts"
import { PPR_BOOT, PPR_RUNTIME, pprScriptHashes } from "./runtime.ts"
import type { SharedShellStore, StoredEntry } from "./shell-store.ts"

export {
  type DynamicHole,
  type HoleRegistration,
  type HoleStatesMode,
  PPR_CANCEL_PATH,
  PPR_SERVER,
  type PprRequest,
  type PprServer,
  type PprServerStats,
  PprShellBusy,
  PprShellCold,
  PprShellUnavailable,
  PprShellUnchecked,
  type SharedHole,
  variationQuery,
} from "./contract.ts"

/** The redacted state a blocking render shows for a hole that did not load, as `boundary.ts` does. */
const HOLE_ERROR_STATE: BoundaryError = { name: "Error", message: "Boundary failed" }

const DOCUMENT_END = "</body></html>"

const MODULE_SCRIPT_OPEN = '<script type="module" src="'
const MODULE_SCRIPT_CLOSE = '"></script>'
const RUNTIME_SCRIPT = `<script>${PPR_RUNTIME}</script>`
const BOOT_SCRIPT = `<script>${PPR_BOOT}</script>`

const ENCODER = new TextEncoder()

/** A built shell, shared by every visitor whose request maps to its key. */
const NO_BYTES = new Uint8Array(0)

interface ShellEntry {
  readonly routeId: string
  /**
   * The document up to (not including) `</body></html>` and the request script, encoded once with
   * room for the token at {@link tokenAt}: each response copies it and writes its token in.
   */
  readonly first: Uint8Array
  readonly tokenAt: number
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
  /** When this process last saw it in the shared store; unset for an entry kept only here. */
  checkedAt: number | undefined
}

/** A shared hole's frame, built once for every visitor whose request maps to its key. */
interface HoleEntry {
  readonly routeId: string
  /** The finished frame, encoded once. */
  readonly frame: Uint8Array
  /** The loader's output after its `output` projection, for a data request or a blocking render. */
  readonly data: unknown
  readonly bytes: number
  readonly builtAt: number
  readonly tags: readonly string[]
  /** The live keys its loader declared, watched for every visitor it serves. */
  readonly keys: readonly string[]
  failures: number
  retryAt: number
  checkedAt: number | undefined
}

type Entry = ShellEntry | HoleEntry

export interface PprServerConfig {
  readonly options: ResolvedPprOptions
  readonly adapter: RenderAdapter
  readonly csp?: CspPolicy
  /** Part of every shell key, so a shell built by one deployment is never served by another. */
  readonly deployment: string
  /** The client entry `shellChecks` was recorded for; `deployment` when not given. */
  readonly clientEntry?: string
  readonly cancelUrl: string
  /**
   * The routes whose shell import check passed, for this deployment. A route not listed, or a record
   * made for another deployment, gets no shared shell (fail closed). `"unchecked-development"` waives
   * the check and is refused in production.
   */
  readonly shellChecks: ShellCheckRecord | "unchecked-development"
  /** Milliseconds, for shell freshness. Tests pass their own clock. */
  readonly now?: () => number
  /** Shells shared with other processes, behind this process's own; signed entries only. */
  readonly shared?: SharedShellStore | undefined
}

/** One hole of a response, started: exactly one of `hit`, `entry` and `run` is set. */
type HoleStart =
  | {
      readonly hole: HoleRegistration
      /** A shared hole's entry held here when the hole started: its frame goes out with the shell. */
      readonly hit: HoleEntry
      readonly entry?: undefined
      readonly run?: undefined
    }
  | {
      readonly hole: HoleRegistration
      /** A shared hole's entry, being read or built; aborted on the visitor's deadline. */
      readonly entry: Promise<HoleRun<HoleEntry>>
      readonly hit?: undefined
      readonly run?: undefined
    }
  | {
      readonly hole: HoleRegistration
      /** The hole's loader, run for this visitor. */
      readonly run: Promise<HoleRun<unknown>>
      readonly hit?: undefined
      readonly entry?: undefined
    }

/** One streamed response's own queue of frames its client has not read yet. */
interface StreamState {
  readonly queue: Uint8Array[]
  queued: number
  overflowed: boolean
  ending: boolean
  dead: boolean
  /** The reader is waiting on a read the queue could not fill: the next frame goes straight to it. */
  wanted: boolean
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

// No `?.`: a bundler's NODE_ENV define replaces only the plain member read, and this runs per request.
const isProduction = (): boolean =>
  typeof process !== "undefined" && process.env.NODE_ENV === "production"

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const joined = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.length
  }
  return joined
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
/** A token is 16 random bytes in unpadded base64url: always this many ASCII characters. */
const TOKEN_LENGTH = 22
const tokenBytes = new Uint8Array(16)
/** Where a shell's bytes hold each response's token. */
const TOKEN_ROOM = "A".repeat(TOKEN_LENGTH)

const randomToken = (): string => {
  crypto.getRandomValues(tokenBytes)
  let token = ""
  for (let at = 0; at < 15; at += 3) {
    const n =
      ((tokenBytes[at] ?? 0) << 16) | ((tokenBytes[at + 1] ?? 0) << 8) | (tokenBytes[at + 2] ?? 0)
    token +=
      BASE64URL.charAt(n >> 18) +
      BASE64URL.charAt((n >> 12) & 63) +
      BASE64URL.charAt((n >> 6) & 63) +
      BASE64URL.charAt(n & 63)
  }
  const last = tokenBytes[15] ?? 0
  return token + BASE64URL.charAt(last >> 2) + BASE64URL.charAt((last & 3) << 4)
}

const frozenParts = new WeakMap<
  Omit<BoundaryRequestCtx, "signal" | "live">,
  Pick<BoundaryRequestCtx, "params" | "search">
>()

/** `ctx.live` outside a live load: keys are declared for nobody. */
const NO_LIVE = (): void => {}

/** The server component a dynamic hole shows, if it shows one. */
const componentOf = (hole: HoleRegistration): object | undefined =>
  hole.mode === "dynamic" ? serverHoleComponent(hole.render) : undefined

/** A frozen context per invocation, so no hole changes what a sibling sees. The frozen params and
 * search are copied once per request and shared. */
const holeCtx = (
  context: Omit<BoundaryRequestCtx, "signal" | "live">,
  signal: AbortSignal,
  live: (...keys: string[]) => void,
): BoundaryRequestCtx => {
  let parts = frozenParts.get(context)
  if (parts === undefined) {
    parts = {
      params: Object.freeze({ ...context.params }),
      search: Object.freeze({ ...context.search }),
    }
    frozenParts.set(context, parts)
  }
  return Object.freeze({
    request: context.request,
    params: parts.params,
    api: context.api,
    env: context.env,
    draft: context.draft,
    search: parts.search,
    signal,
    live,
  })
}

/** What a response's holes stop for: the response's own aborts, or a request's signal on the data path. */
interface AbortSource {
  readonly aborted: boolean
  readonly reason: unknown
  watch(onAbort: () => void): void
}

const signalSource = (signal: AbortSignal): AbortSource => ({
  get aborted() {
    return signal.aborted
  },
  get reason() {
    return signal.reason
  },
  watch(onAbort) {
    watchAbort(signal, onAbort)
  },
})

interface HoleDeadline {
  readonly signal: AbortSignal
  /** Calls `onAbort` once the signal aborts, until the returned function is called. */
  watch(onAbort: () => void): () => void
  /** One of the holes settled; the last one clears the timer. */
  leave(): void
}

interface HoleDeadlines {
  join(timeoutMs: number): HoleDeadline
}

/**
 * Holes that start together with one timeout share its signal and timer: a controller, listener and
 * timer per hole cost more under load than the holes. Not `AbortSignal.timeout`: its timer stays
 * pending after the holes settle. Only this code aborts the signal, so its watchers are called here
 * and the signal gets no native listener.
 */
const holeDeadlines = (response: AbortSource): HoleDeadlines => {
  const byTimeout = new Map<number, HoleDeadline & { joined: number }>()
  return {
    join(timeoutMs) {
      let deadline = byTimeout.get(timeoutMs)
      if (deadline === undefined) {
        const own = new AbortController()
        const watchers = new Set<() => void>()
        const stop = (reason: unknown): void => {
          if (own.signal.aborted) return
          own.abort(reason)
          for (const watcher of watchers) watcher()
        }
        if (response.aborted) own.abort(response.reason)
        else response.watch(() => stop(response.reason))
        const timer = setTimeout(
          () => stop(new DOMException("The operation timed out.", "TimeoutError")),
          timeoutMs,
        )
        const created = {
          signal: own.signal,
          joined: 0,
          watch(onAbort: () => void): () => void {
            watchers.add(onAbort)
            return () => {
              watchers.delete(onAbort)
            }
          },
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

// Keys a full store has seen fewer than `shellAfterRequests` times, forgotten together once this many
// wait, so a crawl of unique paths holds a bounded map.
const MAX_SIGHTINGS = 10_000

/** What an entry counts against the store's byte budget beside its key, document and data. */
const ENTRY_BYTES = 256

// Roughly how JSC and V8 lay out a loader's output: a header per object and per string, a slot per
// element or property, a byte per character (a two-byte string holds twice that).
const OBJECT_BYTES = 32
const STRING_BYTES = 24
const SLOT_BYTES = 8
// Deeper than any document nests, so only a cycle reaches it.
const MAX_DATA_DEPTH = 256

const isHolder = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

/**
 * About how many heap bytes a shell loader's output holds. The count stops once it passes `room`, so
 * an output too large for the store costs no more than the store's budget to measure.
 */
function heldBytes(value: unknown, room: number, depth = 0): number {
  if (typeof value === "string") return STRING_BYTES + value.length
  if (!isHolder(value)) return SLOT_BYTES
  if (depth === MAX_DATA_DEPTH) return Number.POSITIVE_INFINITY
  let bytes = OBJECT_BYTES
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && bytes <= room; i++)
      bytes += SLOT_BYTES + heldBytes(value[i], room - bytes, depth + 1)
    return bytes
  }
  for (const key in value) {
    bytes += 2 * SLOT_BYTES + heldBytes(value[key], room - bytes, depth + 1)
    if (bytes > room) break
  }
  return bytes
}

const notFoundSignal = (): unknown => {
  try {
    return notFound()
  } catch (signal) {
    return signal
  }
}

const DECODER = new TextDecoder()

// How long a shared store keeps a shell that has no `revalidate`: a year, as good as forever.
const KEEP_UNREVALIDATED_SECONDS = 365 * 24 * 60 * 60

// Taken when this module is evaluated, before any request: a build run through it sees no visitor's
// async context, even in an app created while a request was being handled.
const detached: <T>(fn: () => T) => T =
  globalThis.process?.getBuiltinModule?.("node:async_hooks")?.AsyncLocalStorage?.snapshot?.() ??
  ((fn) => fn())

/** A 404 entry answers as the shell loader's own `notFound()` did. */
const served = (entry: ShellEntry): ShellEntry | Promise<never> =>
  entry.notFound === undefined ? entry : Promise.reject(entry.notFound)

interface BuildDeadline {
  readonly signal: AbortSignal
  /**
   * `work`, or the deadline's reason once it passes first: a loader that ignores its signal leaves no
   * request waiting on it, and its late result reaches no one.
   */
  bound<T>(work: Promise<T>): Promise<T>
  clear(): void
}

/**
 * A build's deadline. One timer aborts the signal and fails the bound work, so a build registers no
 * listener. Not `AbortSignal.timeout`: under a run of misses its timers would stay pending long after
 * the builds settle.
 */
const buildDeadline = (ms: number): BuildDeadline => {
  const controller = new AbortController()
  let expire: (reason: unknown) => void = () => {}
  const timer = setTimeout(() => {
    const reason = new DOMException("The operation timed out.", "TimeoutError")
    controller.abort(reason)
    expire(reason)
  }, ms)
  return {
    signal: controller.signal,
    bound: (work) =>
      new Promise((resolve, reject) => {
        expire = reject
        work.then(resolve, reject)
      }),
    clear: () => clearTimeout(timer),
  }
}

/** `read`, or a miss once `ms` pass: a shared store that stalls is answered by a build, not a wait. */
const missAfter = <T>(read: Promise<T | undefined>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, ms, undefined)
  })
  return Promise.race([read, late]).finally(() => clearTimeout(timer))
}

export function createPprServer(config: PprServerConfig): PprServer {
  const { options, adapter, deployment, shellChecks } = config
  // With the beacon off, the request script names no address, so the runtime sends none.
  const cancelUrl = options.cancelBeacon ? config.cancelUrl : ""
  const renderFragment = adapter.renderFragment
  if (renderFragment === undefined) {
    throw new TypeError("[nifra/web] ppr: the render adapter does not implement renderFragment")
  }
  if (shellChecks === "unchecked-development" && isProduction()) {
    throw new TypeError("[nifra/web] ppr: production needs the build's shell check records")
  }
  const ownRecord = (): boolean =>
    shellChecks !== "unchecked-development" &&
    shellChecks.deployment === (config.clientEntry ?? deployment)
  const checked = (routeId: string): boolean =>
    shellChecks === "unchecked-development" ||
    (ownRecord() && Object.hasOwn(shellChecks.routes, routeId))
  /** Whether the build checked this shared hole's loader with its route's shell. */
  const checkedShared = (routeId: string, name: string): boolean =>
    shellChecks === "unchecked-development" ||
    (ownRecord() &&
      Object.hasOwn(shellChecks.routes, routeId) &&
      shellChecks.sharedHoles?.[routeId]?.includes(name) === true)
  const now = config.now ?? Date.now
  const shared = config.shared
  // One shared-store read per key at a time; concurrent misses wait on it.
  const shellLookups = new Map<string, Promise<ShellEntry | undefined>>()
  const holeLookups = new Map<string, Promise<HoleEntry | undefined>>()
  const untaggableWarned = new Set<string>()
  const uncheckedHoleWarned = new Set<string>()
  // Shells and shared hole frames, under one byte budget and one entry cap per route.
  const settled = new Map<string, Entry>()
  const sightings = new Map<string, number>()
  const routeCounts = new Map<string, number>()
  let storedBytes = 0
  const builds = new Map<string, Promise<ShellEntry>>()
  const holeBuilds = new Map<string, Promise<HoleEntry>>()
  // Shell and shared hole builds, which share the route's limit.
  const buildsByRoute = new Map<string, number>()
  // A build records the count when it starts and is not stored if one of its tags was invalidated
  // since. Only running builds read the map, so it empties whenever none run.
  let invalidations = 0
  const invalidatedAt = new Map<string, number>()
  const live = new Map<string, (reason: unknown) => void>()
  const cspHeaders = new Map<string, Promise<string | undefined>>()
  const thinWarned = new Set<string>()
  const oversizeWarned = new Set<string>()
  const emptyWarned = new Map<string, Set<string>>()
  const fallbackHtml = new WeakMap<HoleRegistration, Promise<string>>()
  // A route's request script, with room for the token, serialized once per set of hole names.
  const requestScripts = new Map<
    string,
    { readonly text: string; readonly bytes: number; readonly tokenAt: number }
  >()
  const requestScriptOf = (holes: readonly HoleRegistration[]) => {
    const names = holes.map((hole) => hole.name)
    const sharedNames = holes.filter((hole) => hole.mode === "shared").map((hole) => hole.name)
    const key = `${names.join(",")}|${sharedNames.join(",")}`
    let script = requestScripts.get(key)
    if (script === undefined) {
      const [before, after] = requestScriptAround(cancelUrl, names, sharedNames)
      const text = before + TOKEN_ROOM + after
      script = { text, bytes: ENCODER.encode(text).length, tokenAt: ENCODER.encode(before).length }
      requestScripts.set(key, script)
    }
    return script
  }

  // A fallback comes from its registration alone and every shell holds it, so it renders once.
  const fallbackOf = (hole: HoleRegistration): Promise<string> => {
    let html = fallbackHtml.get(hole)
    if (html === undefined) {
      const fallback = hole.fallback
      html =
        fallback === undefined
          ? Promise.resolve("")
          : Promise.resolve().then(() => renderFragment.call(adapter, () => fallback, {}))
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

  const store = (key: string, entry: Entry): void => {
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

  /**
   * Whether a held entry is due a read of the shared store: another process may have purged it there,
   * and reading it again is how that purge reaches this one.
   */
  const recheckDue = (entry: Entry): boolean =>
    entry.checkedAt !== undefined && now() - entry.checkedAt >= options.sharedRecheckMs

  const finishShell = async (
    key: string,
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
    const bodyEnd = html.length - DOCUMENT_END.length
    // Every change to the rendered document, made in one pass that copies it once.
    const edits: Array<{ readonly from: number; readonly to: number; readonly html: string }> = [
      { from: headEnd, to: headEnd, html: RUNTIME_SCRIPT },
    ]
    // The client entry must not wait for the end of the document, which is the slowest hole.
    for (
      let at = html.indexOf(MODULE_SCRIPT_OPEN);
      at !== -1 && at < bodyEnd;
      at = html.indexOf(MODULE_SCRIPT_OPEN, at + 1)
    ) {
      const srcEnd = html.indexOf('"', at + MODULE_SCRIPT_OPEN.length)
      const end = srcEnd + MODULE_SCRIPT_CLOSE.length
      if (srcEnd === -1 || !html.startsWith(MODULE_SCRIPT_CLOSE, srcEnd)) continue
      if (at < headEnd && end > headEnd) continue
      const src = html.slice(at + MODULE_SCRIPT_OPEN.length, srcEnd)
      edits.push({
        from: at,
        to: end,
        html: `<link rel="modulepreload" href="${src}">${BOOT_SCRIPT}`,
      })
    }
    const fallbacks = new Map<string, string>()
    for (const hole of request.holes) {
      const fallback = await fallbackOf(hole)
      fallbacks.set(hole.name, fallback)
      if (fallback.trim() !== "" || isProduction()) continue
      const warned = emptyWarned.get(request.routeId) ?? new Set<string>()
      if (warned.has(hole.name)) continue
      emptyWarned.set(request.routeId, warned.add(hole.name))
      console.warn(
        `[nifra/web] ppr: hole "${hole.name}" of "${request.routeId}" has an empty fallback, so a browser without JavaScript shows nothing in its place and the page moves when it fills`,
      )
    }
    for (const insert of holeFallbackInserts(html, fallbacks))
      edits.push({ from: insert.at, to: insert.at, html: insert.html })
    edits.sort((a, b) => a.from - b.from)
    let prefix = ""
    let from = 0
    for (const edit of edits) {
      prefix += html.slice(from, edit.from) + edit.html
      from = edit.to
    }
    prefix += html.slice(from, bodyEnd)
    if (!isProduction() && !thinWarned.has(request.routeId)) {
      const text = textLength(prefix.slice(Math.max(prefix.indexOf("<body"), 0)))
      if (text < WEBKIT_PAINT_CHARS) {
        thinWarned.add(request.routeId)
        console.warn(
          `[nifra/web] ppr: the shell of "${request.routeId}" has ${text} characters of text. Safari paints a loading document only once it holds about ${WEBKIT_PAINT_CHARS}, so it shows this page only when its slowest hole ends`,
        )
      }
    }
    const script = requestScriptOf(request.holes)
    // One encode: the request script's bytes are known, so the prefix's are the rest.
    let first = ENCODER.encode(prefix + script.text)
    const short = options.minShellBytes - (first.length - script.bytes)
    if (short > 0) first = ENCODER.encode(`${prefix}<!--${" ".repeat(short)}-->${script.text}`)
    const bytes = ENTRY_BYTES + key.length + first.length
    return {
      routeId: request.routeId,
      first,
      tokenAt: first.length - script.bytes + script.tokenAt,
      data,
      bytes: bytes + heldBytes(data, options.shellStoreBytes - bytes),
      builtAt: now(),
      tags: request.tags(),
      failures: 0,
      retryAt: 0,
      checkedAt: undefined,
    }
  }

  /**
   * The shared store's copy of an entry, unless its tags could never be dropped there. True when the
   * write started, so the entry is one a purge on another process can reach.
   */
  const share = (
    key: string,
    stored: StoredEntry,
    keepSeconds: number,
    request: PprRequest,
    fence: Promise<number | undefined>,
  ): boolean => {
    if (shared === undefined) return false
    if (stored.tags.length > 0 && shared.invalidateTag === undefined) {
      if (!untaggableWarned.has(stored.routeId)) {
        untaggableWarned.add(stored.routeId)
        console.warn(
          `[nifra/web] ppr: route "${stored.routeId}" lists revalidateTags, which the shared store cannot drop, so its shells and shared holes stay in this process`,
        )
      }
      return false
    }
    const write = fence
      .then((at) => shared.set(key, stored, keepSeconds, at))
      .catch((error: unknown) =>
        console.error("[nifra/web] ppr: writing to the shared store failed", {
          route: stored.routeId,
          kind: error instanceof Error ? "error" : typeof error,
        }),
      )
    request.waitUntil?.(write)
    return true
  }

  const shareShell = (
    key: string,
    entry: ShellEntry,
    request: PprRequest,
    fence: Promise<number | undefined>,
  ): boolean =>
    share(
      key,
      {
        routeId: entry.routeId,
        html: DECODER.decode(entry.first),
        tokenAt: entry.tokenAt,
        data: entry.data,
        builtAt: entry.builtAt,
        tags: entry.tags,
        notFound: entry.notFound !== undefined,
      },
      entry.notFound !== undefined
        ? options.notFoundTtlSeconds
        : request.revalidate === undefined
          ? KEEP_UNREVALIDATED_SECONDS
          : staleLimitMs(request.revalidate) / 1000,
      request,
      fence,
    )

  /** A shell read back from the shared store, as this process keeps it. */
  const entryOf = (key: string, stored: StoredEntry): ShellEntry => {
    const first = stored.notFound ? NO_BYTES : ENCODER.encode(stored.html)
    const bytes = ENTRY_BYTES + key.length + first.length
    return {
      routeId: stored.routeId,
      first,
      tokenAt: stored.tokenAt,
      data: stored.data,
      bytes: bytes + heldBytes(stored.data, options.shellStoreBytes - bytes),
      builtAt: stored.builtAt,
      tags: stored.tags,
      notFound: stored.notFound ? notFoundSignal() : undefined,
      failures: 0,
      retryAt: 0,
      checkedAt: now(),
    }
  }

  const leaveBuild = (routeId: string): void => {
    const running = (buildsByRoute.get(routeId) ?? 1) - 1
    if (running === 0) buildsByRoute.delete(routeId)
    else buildsByRoute.set(routeId, running)
    if (builds.size === 0 && holeBuilds.size === 0) invalidatedAt.clear()
  }

  const startBuild = (key: string, request: PprRequest): Promise<ShellEntry> => {
    const routeId = request.routeId
    buildsByRoute.set(routeId, (buildsByRoute.get(routeId) ?? 0) + 1)
    const startedAt = invalidations
    // Read before the build starts, so a purge the shared store sees during it keeps it out.
    const fence: Promise<number | undefined> =
      shared === undefined ? Promise.resolve(undefined) : shared.fence().catch(() => undefined)
    const deadline = buildDeadline(options.maxHoleTimeoutMs)
    const loading = detached(() =>
      request.loadShell(deadline.signal).then(
        async (data) =>
          finishShell(
            key,
            await request.renderShellDocument(data, pendingStates(request.holes)),
            request,
            data,
          ),
        (error: unknown): ShellEntry => {
          // A missing record is cached briefly, so a flood of unknown ids runs no loader twice.
          if (!isStatusSignal(error) || error.status !== 404) throw error
          return {
            routeId,
            first: NO_BYTES,
            tokenAt: 0,
            data: undefined,
            bytes: ENTRY_BYTES + key.length,
            builtAt: now(),
            tags: request.tags(),
            notFound: error,
            failures: 0,
            retryAt: 0,
            checkedAt: undefined,
          }
        },
      ),
    )
    const building = deadline.bound(loading)
    builds.set(key, building)
    // The route's build is held until the loader itself ends: one that ignores its signal past the
    // deadline still counts, so it cannot leave room for unbounded replacements.
    loading.then(
      () => leaveBuild(routeId),
      () => leaveBuild(routeId),
    )
    const done = (): void => {
      deadline.clear()
      if (builds.get(key) === building) builds.delete(key)
    }
    building.then((entry) => {
      const fenced = entry.tags.some((tag) => (invalidatedAt.get(tag) ?? -1) > startedAt)
      done()
      if (fenced) return
      if (shareShell(key, entry, request, fence)) entry.checkedAt = now()
      if (entry.bytes <= options.shellStoreBytes) return store(key, entry)
      // Kept, it would empty the store and still overrun it; a stale entry it replaces goes too.
      evict(key)
      if (!isProduction() && !oversizeWarned.has(routeId)) {
        oversizeWarned.add(routeId)
        console.warn(
          `[nifra/web] ppr: a shell of "${routeId}" holds more than shellStoreBytes with its loader data, so it is built for every request`,
        )
      }
    }, done)
    return building
  }

  /** Behind a stale shell: one rebuild per key, within the route's build limit, backing off on failure. */
  const rebuild = (key: string, request: PprRequest, stale: ShellEntry): void => {
    if (builds.has(key) || now() < stale.retryAt) return
    if ((buildsByRoute.get(request.routeId) ?? 0) >= options.shellBuildConcurrency) return
    const building = startBuild(key, request)
    // No visitor waits on it, so a platform that stops work at the response's end must be told.
    request.waitUntil?.(building.catch(() => undefined))
    building.catch((error: unknown) => {
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

  /** Whether a new shell of the route would likely push another out: an average entry overruns. */
  const full = (routeId: string): boolean =>
    (settled.size > 0 && storedBytes + storedBytes / settled.size > options.shellStoreBytes) ||
    (routeCounts.get(routeId) ?? 0) >= options.shellEntriesPerRoute

  /**
   * Counts a request for a key with no shell; true once the key may build one. Only a full store
   * counts, so with room every key builds at once, and when full a path seen once cannot evict.
   */
  const due = (key: string, routeId: string): boolean => {
    if (options.shellAfterRequests === 1 || settled.has(key) || builds.has(key)) return true
    if (!full(routeId)) return true
    const seen = (sightings.get(key) ?? 0) + 1
    if (seen >= options.shellAfterRequests) {
      sightings.delete(key)
      return true
    }
    if (sightings.size >= MAX_SIGHTINGS) sightings.clear()
    sightings.set(key, seen)
    return false
  }

  /** Serves `entry` if it is still usable for `request`, rebuilding behind a stale one. */
  const serveEntry = (
    key: string,
    entry: ShellEntry,
    request: PprRequest,
  ): Promise<ShellEntry> | undefined => {
    const age = now() - entry.builtAt
    if (entry.notFound !== undefined) {
      return age < options.notFoundTtlSeconds * 1000 ? Promise.reject(entry.notFound) : undefined
    }
    if (request.revalidate === undefined || age < request.revalidate * 1000) {
      return Promise.resolve(entry)
    }
    if (age < staleLimitMs(request.revalidate)) {
      rebuild(key, request, entry)
      return Promise.resolve(entry)
    }
    return undefined
  }

  const build = (key: string, request: PprRequest): Promise<ShellEntry> => {
    const running = builds.get(key)
    if (running !== undefined) return running.then(served)
    if ((buildsByRoute.get(request.routeId) ?? 0) >= options.shellBuildConcurrency) {
      return Promise.reject(new PprShellBusy(request.routeId))
    }
    for (const hole of request.holes) assertHoleName(hole.name)
    return startBuild(key, request).then(served)
  }

  /** The shared store's shell for `key`, kept here once read; a failed or missing read builds one. */
  const fromShared = (
    sharedStore: SharedShellStore,
    key: string,
    request: PprRequest,
  ): Promise<ShellEntry> => {
    let lookup = shellLookups.get(key)
    if (lookup === undefined) {
      const read = missAfter(sharedStore.get(key), options.holeTimeoutMs).then(
        (found) => (found === undefined ? undefined : entryOf(key, found)),
        () => undefined,
      )
      lookup = read
      shellLookups.set(key, read)
      read.then(() => shellLookups.delete(key))
    }
    return lookup.then((entry) => {
      if (entry !== undefined && entry.routeId === request.routeId) {
        const usable = serveEntry(key, entry, request)
        if (usable !== undefined) {
          if (!settled.has(key) && entry.bytes <= options.shellStoreBytes) store(key, entry)
          return usable
        }
      }
      return build(key, request)
    })
  }

  const shellFor = (
    request: PprRequest,
    key = shellKey(deployment, request),
  ): Promise<ShellEntry> => {
    const entry = settled.get(key)
    if (entry !== undefined && "first" in entry) {
      settled.delete(key)
      settled.set(key, entry)
      const usable = recheckDue(entry) ? undefined : serveEntry(key, entry, request)
      if (usable !== undefined) return usable
      evict(key)
    }
    const running = builds.get(key)
    if (running !== undefined) return running.then(served)
    if (!checked(request.routeId)) return Promise.reject(new PprShellUnchecked(request.routeId))
    return shared === undefined ? build(key, request) : fromShared(shared, key, request)
  }

  /** What a shared hole's loader gets: the shell's context, under the build's own signal. */
  const sharedHoleCtx = (
    request: PprRequest,
    signal: AbortSignal,
    live: (...keys: string[]) => void,
  ): SharedHoleCtx => Object.freeze({ ...request.shellContext, signal, live })

  /** A shared hole's frame and data, rendered once for every visitor. */
  const finishHole = async (
    key: string,
    request: PprRequest,
    hole: SharedHole,
    data: unknown,
    keys: readonly string[],
  ): Promise<HoleEntry> => {
    // The visitor's status and headers went out with the shell, so a hole has none to give.
    if (isControlFlow(data) || isStatusSignal(data))
      throw new TypeError("[nifra/web] ppr: a shared hole returned a redirect or status")
    // The id prefix is the hole's own, never a request's, so every visitor gets the same bytes.
    const html = await renderFragment.call(
      adapter,
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: defineBoundary binds render to its own load's output; the registration erases that generic, and the value came from that load.
      () => hole.render(data as never),
      { idPrefix: `nifra-${hole.name}-`, hydrates: hole.interactive === true },
    )
    validateHoleHtml(html)
    // A component that copied the nonce into the frame would hand it to every visitor.
    if (html.includes(" nonce=")) {
      throw new Error(
        `[nifra/web] ppr: shared hole "${hole.name}" of "${request.routeId}" rendered a nonce`,
      )
    }
    const frame = ENCODER.encode(
      encodeHoleFrame(
        hole.name,
        hole.interactive === true ? { html, props: data } : { html },
        options.frameBytes,
      ),
    )
    const bytes = ENTRY_BYTES + key.length + frame.length
    return {
      routeId: request.routeId,
      frame,
      data,
      bytes: bytes + heldBytes(data, options.shellStoreBytes - bytes),
      builtAt: now(),
      tags: request.holeTags(hole),
      keys,
      failures: 0,
      retryAt: 0,
      checkedAt: undefined,
    }
  }

  /**
   * Build one shared hole's entry, detached from the visitor, under its own deadline, and keep it.
   * With `slot`, the build is hole work under admission instead of one of the route's builds.
   */
  const startHoleBuild = (
    key: string,
    request: PprRequest,
    hole: SharedHole,
    slot: HoleSlot | undefined,
  ): Promise<HoleEntry> => {
    const routeId = request.routeId
    if (slot === undefined) buildsByRoute.set(routeId, (buildsByRoute.get(routeId) ?? 0) + 1)
    const startedAt = invalidations
    const fence: Promise<number | undefined> =
      shared === undefined ? Promise.resolve(undefined) : shared.fence().catch(() => undefined)
    const deadline = buildDeadline(options.maxHoleTimeoutMs)
    const signal = deadline.signal
    // Keys count only when declared before the loader settles, as in a visitor's live load.
    const keys = new Set<string>()
    let declaring = true
    const declare = (...declared: string[]): void => {
      if (declaring) for (const declaredKey of declared) keys.add(String(declaredKey))
    }
    const load = (): Promise<HoleEntry> =>
      detached(() =>
        Promise.resolve()
          .then(() => hole.load?.(sharedHoleCtx(request, signal, declare)))
          .finally(() => {
            declaring = false
          })
          .then((data) => finishHole(key, request, hole, data, [...keys])),
      )
    const loading =
      slot === undefined
        ? load()
        : slot
            .run(`${routeId}|${hole.name}`, signal, load)
            .then((run) =>
              run.ok ? run.value : Promise.reject(run.error ?? new PprShellBusy(routeId)),
            )
    const building = deadline.bound(loading)
    holeBuilds.set(key, building)
    // As for a shell: the route's build is held until the loader itself ends.
    const leave = (): void => {
      if (slot === undefined) leaveBuild(routeId)
      else if (builds.size === 0 && holeBuilds.size === 0) invalidatedAt.clear()
    }
    loading.then(leave, leave)
    const done = (): void => {
      deadline.clear()
      if (holeBuilds.get(key) === building) holeBuilds.delete(key)
    }
    building.then(
      (entry) => {
        const fenced = entry.tags.some((tag) => (invalidatedAt.get(tag) ?? -1) > startedAt)
        done()
        if (fenced) return
        const written = share(
          key,
          {
            routeId,
            html: DECODER.decode(entry.frame),
            tokenAt: 0,
            data: entry.data,
            builtAt: entry.builtAt,
            tags: entry.tags,
            keys: entry.keys,
            notFound: false,
          },
          staleLimitMs(hole.revalidate) / 1000,
          request,
          fence,
        )
        if (written) entry.checkedAt = now()
        if (entry.bytes <= options.shellStoreBytes) store(key, entry)
        else evict(key)
      },
      (error: unknown) => {
        done()
        console.error("[nifra/web] ppr: shared hole build failed", {
          route: routeId,
          hole: hole.name,
          kind: error instanceof Error ? "error" : typeof error,
        })
      },
    )
    return building
  }

  /**
   * A shared hole's build. Over the route's build limit it still runs, as hole work under admission:
   * it reads no request, so storing it is as safe as any build, and the next visitor hits it instead
   * of calling a slow upstream again.
   */
  const buildHole = (key: string, request: PprRequest, hole: SharedHole): Promise<HoleEntry> => {
    const running = holeBuilds.get(key)
    if (running !== undefined) return running
    if ((buildsByRoute.get(request.routeId) ?? 0) < options.shellBuildConcurrency)
      return startHoleBuild(key, request, hole, undefined)
    const slot = admission.slot()
    if (slot === undefined) return Promise.reject(new PprShellBusy(request.routeId))
    const building = startHoleBuild(key, request, hole, slot)
    slot.seal()
    return building
  }

  /** `entry` if it is still usable, rebuilding behind a stale one within the route's build limit. */
  const usableHole = (
    key: string,
    entry: HoleEntry,
    request: PprRequest,
    hole: SharedHole,
  ): HoleEntry | undefined => {
    const age = now() - entry.builtAt
    if (age < hole.revalidate * 1000) return entry
    if (age >= staleLimitMs(hole.revalidate)) return undefined
    const routeId = request.routeId
    if (
      !holeBuilds.has(key) &&
      now() >= entry.retryAt &&
      (buildsByRoute.get(routeId) ?? 0) < options.shellBuildConcurrency
    ) {
      const building = startHoleBuild(key, request, hole, undefined)
      // No visitor waits on it, so a platform that stops work at the response's end must be told.
      request.waitUntil?.(building.catch(() => undefined))
      building.catch(() => {
        entry.failures++
        entry.retryAt = now() + Math.min(2 ** entry.failures, hole.revalidate) * 1000
      })
    }
    return entry
  }

  /** The shared hole's entry this process holds, if it is usable now: a hit costs no promise. */
  const heldHole = (key: string, request: PprRequest, hole: SharedHole): HoleEntry | undefined => {
    const entry = settled.get(key)
    if (entry === undefined || "first" in entry) return undefined
    settled.delete(key)
    settled.set(key, entry)
    const usable = recheckDue(entry) ? undefined : usableHole(key, entry, request, hole)
    if (usable === undefined) evict(key)
    return usable
  }

  /** The shared hole's entry: being built, in the shared store, or built now. */
  const holeEntry = (key: string, request: PprRequest, hole: SharedHole): Promise<HoleEntry> => {
    const running = holeBuilds.get(key)
    if (running !== undefined) return running
    if (shared === undefined) return buildHole(key, request, hole)
    let lookup = holeLookups.get(key)
    if (lookup === undefined) {
      const read = missAfter(shared.get(key), options.holeTimeoutMs).then(
        (found): HoleEntry | undefined => {
          if (found === undefined || found.notFound) return undefined
          const frame = ENCODER.encode(found.html)
          const bytes = ENTRY_BYTES + key.length + frame.length
          return {
            routeId: found.routeId,
            frame,
            data: found.data,
            bytes: bytes + heldBytes(found.data, options.shellStoreBytes - bytes),
            builtAt: found.builtAt,
            tags: found.tags,
            keys: found.keys ?? [],
            failures: 0,
            retryAt: 0,
            checkedAt: now(),
          }
        },
        () => undefined,
      )
      lookup = read
      holeLookups.set(key, read)
      read.then(() => holeLookups.delete(key))
    }
    return lookup.then((entry) => {
      if (entry !== undefined && entry.routeId === request.routeId) {
        const usable = usableHole(key, entry, request, hole)
        if (usable !== undefined) {
          if (!settled.has(key) && entry.bytes <= options.shellStoreBytes) store(key, entry)
          return usable
        }
      }
      return buildHole(key, request, hole)
    })
  }

  /**
   * The key of `hole`'s shared entry for `request`, or `undefined` when this request must not read
   * or fill one: a draft, a hole the build did not check, or a key a full store has seen too rarely.
   */
  const sharedKey = (request: PprRequest, hole: SharedHole): string | undefined => {
    if (request.holeContext.draft) return undefined
    if (!checkedShared(request.routeId, hole.name)) {
      const warning = `${request.routeId}|${hole.name}`
      if (checked(request.routeId) && !isProduction() && !uncheckedHoleWarned.has(warning)) {
        uncheckedHoleWarned.add(warning)
        console.warn(
          `[nifra/web] ppr: shared hole "${hole.name}" of "${request.routeId}" has no passing build check, so it loads for every visitor. Write its boundaryLoaders entry inline, with revalidate`,
        )
      }
      return undefined
    }
    const key = `ppr-hole:v1|${deployment}|${request.routeId}|${hole.name}|${request.locale ?? ""}|${variationQuery(request.holeContext.params)}|${variationQuery(request.variations)}`
    return due(key, request.routeId) ? key : undefined
  }

  /** Wait for a shared hole's entry until the hole's deadline; the build itself goes on. */
  const awaitHole = (
    key: string,
    request: PprRequest,
    hole: SharedHole,
    deadlines: HoleDeadlines,
  ): Promise<HoleRun<HoleEntry>> => {
    const deadline = deadlines.join(hole.timeout ?? options.holeTimeoutMs)
    return new Promise((resolve) => {
      let unwatch = (): void => {}
      let answered = false
      const answer = (run: HoleRun<HoleEntry>): void => {
        if (answered) return
        answered = true
        unwatch()
        deadline.leave()
        resolve(run)
      }
      const aborted = (): void =>
        answer({ ok: false, reason: "aborted", error: deadline.signal.reason })
      if (deadline.signal.aborted) return aborted()
      unwatch = deadline.watch(aborted)
      holeEntry(key, request, hole).then(
        (value) => answer({ ok: true, value }),
        (error: unknown) => answer({ ok: false, reason: "failed", error }),
      )
    })
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
    if (hole.load === undefined) return Promise.resolve({ ok: true, value: undefined })
    if (slot === undefined) return Promise.resolve(SHED)
    const deadline = deadlines.join(hole.timeout ?? options.holeTimeoutMs)
    const signal = deadline.signal
    const live = request.live?.collector(hole.name) ?? NO_LIVE
    const component = componentOf(hole)
    // A shared hole that is not stored for this request still loads as it is built: no request.
    const invoke =
      hole.mode === "shared"
        ? () => detached(() => hole.load?.(sharedHoleCtx(request, signal, live)))
        : component === undefined
          ? () => hole.load?.(holeCtx(request.holeContext, signal, live))
          : // The component runs under the hole's own deadline and admission, after its loader.
            async () => {
              const input = await hole.load?.(holeCtx(request.holeContext, signal, live))
              if (isControlFlow(input) || isStatusSignal(input)) return input
              if (request.component === undefined) {
                throw new TypeError(
                  `[nifra/web] ppr: hole "${hole.name}" shows a server component that the app's serverComponents does not list under holes for "${request.routeId}"`,
                )
              }
              return request.component(hole.name, component, input, signal)
            }
    return slot
      .run(`${request.routeId}|${hole.name}`, signal, invoke, deadline.watch)
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

  /**
   * Start every hole of one response. A shared hole's held entry is a hit at once; any loader run for
   * this visitor needs the response's slot, and with none free, each such hole gets its error.
   */
  const startHoles = (
    request: PprRequest,
    response: AbortSource,
    holes: readonly HoleRegistration[] = request.holes,
  ): HoleStart[] => {
    let slot: HoleSlot | undefined
    let slotTaken = false
    let deadlines: HoleDeadlines | undefined
    const starts = holes.map((hole): HoleStart => {
      if (hole.mode === "shared") {
        const key = sharedKey(request, hole)
        if (key !== undefined) {
          const hit = heldHole(key, request, hole)
          if (hit !== undefined) return { hole, hit }
          deadlines ??= holeDeadlines(response)
          return { hole, entry: awaitHole(key, request, hole, deadlines) }
        }
      }
      if (!slotTaken) {
        slotTaken = true
        slot = admission.slot()
      }
      deadlines ??= holeDeadlines(response)
      return { hole, run: runHole(slot, request, hole, deadlines) }
    })
    slot?.seal()
    return starts
  }

  const frameOf = async (
    request: PprRequest,
    hole: HoleRegistration,
    run: HoleRun<unknown>,
  ): Promise<string> => {
    if (!run.ok) return errorFrame(hole.name)
    try {
      if (componentOf(hole) !== undefined) {
        const value: unknown = run.value
        const html: unknown =
          typeof value === "object" && value !== null ? Reflect.get(value, "html") : null
        if (typeof value !== "object" || value === null || typeof html !== "string") {
          throw new TypeError("a server component rendered no HTML")
        }
        validateHoleHtml(html)
        // The frame carries the HTML once; the record the islands mount from is the rest.
        const component = Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "html"),
        )
        return encodeHoleFrame(hole.name, { html, component }, options.frameBytes)
      }
      const html = await renderFragment.call(
        adapter,
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: defineBoundary binds render to its own load's output; the registration erases that generic, and the value came from that load.
        () => hole.render(run.value as never),
        { idPrefix: `nifra-${hole.name}-`, hydrates: hole.interactive === true },
      )
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

  // A route's policy is fixed (hash sources, no nonce), so there is one entry per route at most.
  // `Response` copies its init headers, so no response can change a shared one.
  const headersByPolicy = new Map<string | undefined, Headers>()
  const documentHeaders = (csp: string | undefined): Headers => {
    let headers = headersByPolicy.get(csp)
    if (headers === undefined) {
      headers = new Headers({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "x-accel-buffering": "no",
      })
      if (csp !== undefined) headers.set("content-security-policy", csp)
      headersByPolicy.set(csp, headers)
    }
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
      const key = shellKey(deployment, request)
      // Before any hole starts: a key with no shell yet renders whole and runs its holes there.
      if (!due(key, request.routeId)) throw new PprShellCold(request.routeId)
      if (request.request.method === "HEAD") {
        const [, csp] = await Promise.all([shellFor(request, key), cspHeader(request)])
        return new Response(null, { status: 200, headers: documentHeaders(csp) })
      }
      const token = randomToken()
      // Every abort of the response (disconnect, deadline, cancel, write grace) comes through here, so
      // the token retires at once and the holes need no controller or native listener of their own.
      const watchers: Array<() => void> = []
      const response: { aborted: boolean; reason: unknown } & AbortSource = {
        aborted: false,
        reason: undefined,
        watch(onAbort: () => void): void {
          watchers.push(onAbort)
        },
      }
      const abort = (reason: unknown): void => {
        if (response.aborted) return
        response.aborted = true
        response.reason = reason
        live.delete(token)
        for (const watcher of watchers) watcher()
      }
      live.set(token, abort)
      const unwatchDisconnect = watchAbort(request.request.signal, () =>
        abort(request.request.signal.reason),
      )
      const deadlineMs = totalDeadlineMs(
        options,
        request.holes.map((hole) => hole.timeout ?? options.holeTimeoutMs),
      )
      // One timer: the total deadline, then the write grace, which runs from the deadline or from the
      // stream's start, whichever is later.
      let killStream: ((reason: unknown) => void) | undefined
      let graceSpent = false
      const graceOver = (): void => {
        graceSpent = true
        killStream?.(new DOMException("PPR write grace", "TimeoutError"))
      }
      let timer = setTimeout(() => {
        abort(new DOMException("PPR total deadline", "TimeoutError"))
        timer = setTimeout(graceOver, options.writeGraceMs)
      }, deadlineMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        live.delete(token)
        unwatchDisconnect()
      }
      // A cached shell is known at once, so holes start only once it is known to be a page; on a
      // miss they start beside the build, which is where starting early pays. The shell's build is
      // claimed first: a shared hole's build must not take the route's last one from it.
      const cached = settled.has(key)
      const shellAndCsp = Promise.all([shellFor(request, key), cspHeader(request)])
      let runs = cached ? undefined : startHoles(request, response)
      let shell: ShellEntry
      let csp: string | undefined
      try {
        ;[shell, csp] = await shellAndCsp
      } catch (error) {
        abort(error)
        cleanup()
        throw error
      }
      runs ??= startHoles(request, response)

      let sink: ReadableStreamDefaultController<Uint8Array> | undefined
      const state: StreamState = {
        queue: [],
        queued: 0,
        overflowed: false,
        ending: false,
        dead: false,
        wanted: false,
        kill(reason) {
          if (state.dead) return
          state.dead = true
          unsentBytes -= state.queued
          state.queued = 0
          state.queue.length = 0
          streams.delete(state)
          abort(reason)
          cleanup()
          try {
            sink?.error(reason)
          } catch {
            // Already closed or cancelled by the reader: nothing left to error.
          }
        },
      }
      // Everything queued goes out as one chunk: one write per read, not one per frame.
      const send = (stream: ReadableStreamDefaultController<Uint8Array>): void => {
        const chunk = state.queue.length > 1 ? concat(state.queue) : state.queue[0]
        state.queue.length = 0
        if (chunk !== undefined) {
          state.queued -= chunk.length
          unsentBytes -= chunk.length
          stream.enqueue(chunk)
        }
        if (state.ending) {
          state.dead = true
          streams.delete(state)
          stream.close()
          cleanup()
        }
      }
      const wake = (): void => {
        if (!state.wanted || sink === undefined) return
        state.wanted = false
        send(sink)
      }
      const push = (name: string, frame: string | Uint8Array): void => {
        if (state.dead) return
        // A shared frame's bytes serve every visitor, and a reader may write into a chunk.
        let bytes = typeof frame === "string" ? ENCODER.encode(frame) : frame.slice()
        // Past the per-response cap every later hole sends its error frame, a few hundred bytes each.
        if (state.overflowed || state.queued + bytes.length > options.maxUnsentBytesPerResponse) {
          state.overflowed = true
          bytes = ENCODER.encode(errorFrame(name))
        }
        makeRoom(bytes.length)
        if (state.dead) return
        state.queue.push(bytes)
        state.queued += bytes.length
        unsentBytes += bytes.length
        wake()
      }
      streams.add(state)
      killStream = state.kill
      if (graceSpent) timer = setTimeout(graceOver, options.writeGraceMs)
      const pushEnd = (): void => {
        if (state.dead) return
        const end = ENCODER.encode(DOCUMENT_END)
        state.queue.push(end)
        state.queued += end.length
        unsentBytes += end.length
        state.ending = true
        wake()
      }
      // The end is queued in the same turn as the last frame, so the two go out as one write.
      let unframed = runs.length
      // Shared frames this process holds go out with the shell, in its one chunk.
      const hits: Uint8Array[] = []
      for (const start of runs) {
        if (start.hit !== undefined) {
          hits.push(start.hit.frame)
          unframed--
          continue
        }
        const { hole } = start
        const frame: Promise<string | Uint8Array> =
          start.entry !== undefined
            ? start.entry.then((outcome) =>
                outcome.ok ? outcome.value.frame : errorFrame(hole.name),
              )
            : start.run.then((outcome) => frameOf(request, hole, outcome))
        frame.then((framed) => {
          push(hole.name, framed)
          if (--unframed === 0) pushEnd()
        })
      }
      if (unframed === 0) pushEnd()

      const body = new ReadableStream<Uint8Array>(
        {
          start(stream) {
            sink = stream
            // A copy: a reader may write into a chunk, and the shell's bytes serve every visitor.
            const first = hits.length === 0 ? shell.first.slice() : concat([shell.first, ...hits])
            for (let at = 0; at < TOKEN_LENGTH; at++)
              first[shell.tokenAt + at] = token.charCodeAt(at)
            // Every visitor gets the same bytes up to the token, so compression() compresses them once.
            markRepeatedPrefix(first, shell.first, shell.tokenAt)
            stream.enqueue(first)
          },
          // Called only for a read the stream's queue cannot fill, so unread frames stay counted in
          // `state.queue`. Synchronous: an async pull and a promise per frame cost more than the frame.
          pull(stream) {
            if (state.dead) return
            if (state.queue.length === 0 && !state.ending) state.wanted = true
            else send(stream)
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
      const key = shellKey(deployment, request)
      if (!due(key, request.routeId)) throw new PprShellCold(request.routeId)
      return (await shellFor(request, key)).data
    },

    async holeStates(request, mode, signal) {
      const { live, kept } = request
      // A host the client holds reloads as a fill. A server component's hole is always a host: no
      // browser can render it.
      const fills = (hole: HoleRegistration): boolean =>
        (mode !== "omitted" && componentOf(hole) !== undefined) ||
        (mode === "deferred" && request.fill?.has(hole.name) === true)
      const keptStates: Record<string, BoundaryState> = {}
      const holes =
        kept === undefined || kept.size === 0
          ? request.holes
          : request.holes.filter((hole) => {
              if (!kept.has(hole.name)) return true
              keptStates[hole.name] = fills(hole)
                ? { name: hole.name, mode: hole.mode, status: "pending", ppr: true, kept: true }
                : { name: hole.name, mode: hole.mode, status: "pending", kept: true }
              return false
            })
      if (mode === "omitted") {
        live?.done([])
        return { ...pendingStates(holes), ...keptStates }
      }
      const loaded: string[] = []
      const settles: Promise<void>[] = []
      /** A hole that loaded owns its keys in the live load; one that did not has no owner. */
      const settle = (name: string, ok: boolean, keys: readonly string[] = []): void => {
        if (live === undefined) return
        try {
          if (ok && keys.length > 0) live.collector(name)(...keys)
          if (ok) loaded.push(name)
        } catch (error) {
          // A stored entry's keys over the load's budget: the hole loads but is not watched.
          console.error("[nifra/web] ppr: a shared hole's live keys were refused", {
            route: request.routeId,
            hole: name,
            reason: error instanceof Error ? error.message : typeof error,
          })
        }
        live.seal(name)
      }
      const entries = await Promise.all(
        startHoles(request, signalSource(signal), holes).map(
          async (start): Promise<[string, BoundaryState]> => {
            const { hole } = start
            const base: BoundaryState = { name: hole.name, mode: hole.mode, status: "pending" }
            if (hole.errorId !== undefined) Object.assign(base, { errorId: hole.errorId })
            // A held shared entry is ready at once, so a soft navigation renders it with the shell.
            if (start.hit !== undefined) {
              const hit = start.hit
              settle(hole.name, true, hit.keys)
              if (fills(hole))
                return [
                  hole.name,
                  { ...base, ppr: true, fill: frameBodyOf(DECODER.decode(hit.frame)) },
                ]
              return [
                hole.name,
                hit.data === undefined
                  ? { ...base, status: "ready" }
                  : { ...base, status: "ready", data: hit.data },
              ]
            }
            const run: Promise<HoleRun<unknown>> =
              start.entry === undefined
                ? start.run
                : start.entry.then((outcome) =>
                    outcome.ok ? { ok: true, value: outcome.value.data } : outcome,
                  )
            settles.push(
              start.entry === undefined
                ? start.run.then((outcome) => settle(hole.name, outcome.ok))
                : start.entry.then((outcome) =>
                    settle(hole.name, outcome.ok, outcome.ok ? outcome.value.keys : undefined),
                  ),
            )
            if (fills(hole)) {
              const frame =
                start.entry === undefined
                  ? start.run.then((outcome) => frameOf(request, hole, outcome))
                  : start.entry.then((outcome) =>
                      outcome.ok ? DECODER.decode(outcome.value.frame) : errorFrame(hole.name),
                    )
              const body = frame.then(frameBodyOf)
              // A blocking render puts the HTML in the host on the server.
              return [
                hole.name,
                { ...base, ppr: true, fill: mode === "settled" ? await body : defer(body) },
              ]
            }
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
            if (!outcome.ok)
              return [hole.name, { ...base, status: "error", error: HOLE_ERROR_STATE }]
            return [
              hole.name,
              outcome.value === undefined
                ? { ...base, status: "ready" }
                : { ...base, status: "ready", data: outcome.value },
            ]
          },
        ),
      )
      if (live !== undefined) void Promise.all(settles).then(() => live.done(loaded))
      return { ...Object.fromEntries(entries), ...keptStates }
    },

    async invalidateTag(tag) {
      invalidations++
      if (builds.size > 0 || holeBuilds.size > 0) invalidatedAt.set(tag, invalidations)
      for (const [key, entry] of settled) if (entry.tags.includes(tag)) evict(key)
      await shared?.invalidateTag?.(tag)
    },

    cancel(token) {
      const abort = live.get(token)
      if (abort === undefined) return false
      abort(new DOMException("PPR cancelled by the client", "AbortError"))
      return true
    },

    stats() {
      return { ...admission.stats(), slowAborted, unsentBytes }
    },
  }
}
