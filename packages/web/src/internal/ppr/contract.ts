/**
 * What the page executor and `createWebApp` know of partial prerendering. Everything here is small and
 * imports no runtime code: the server, its options and the hole HTML validator load only through
 * `partialPrerendering` (`@nifrajs/web/ppr`), so an app without it carries none of them.
 */
import type {
  BoundaryRegistration,
  BoundaryRequestCtx,
  BoundaryStates,
  ShellCtx,
} from "../../boundary.ts"
import type { CspPolicy } from "../../csp.ts"
import type { RevalidateTags } from "../../isr.ts"
import type { RouteEntry, RouteModule } from "../../manifest.ts"
import type { RenderAdapter } from "../../render-seam.ts"
import type { LoadedLayoutModules } from "../render-document.ts"
import type { PprAdmissionStats } from "./admission.ts"
import type { ResolvedPprOptions } from "./options.ts"

/** An app built with `experimental.ppr` carries its {@link PprServer} under this key. */
export const PPR_SERVER: unique symbol = Symbol.for("nifra.web.ppr")

/** The key of a {@link PprSetup}'s factory. */
export const PPR_SETUP: unique symbol = Symbol.for("nifra.web.ppr.setup")

/** Where the runtime's cancel beacon goes, under the app's base path. */
export const PPR_CANCEL_PATH = "/__nifra/ppr/cancel"

interface HoleFields {
  readonly interactive?: boolean
  readonly timeout?: number
}

/** A hole filled per visitor. */
export type DynamicHole = Extract<BoundaryRegistration, { readonly mode: "dynamic" }> & HoleFields

/** A hole built once for every visitor, with its loader entry's freshness merged in. */
export type SharedHole = Extract<BoundaryRegistration, { readonly mode: "shared" }> &
  HoleFields & {
    readonly revalidate: number
    readonly revalidateTags?: RevalidateTags | undefined
  }

/** The boundary fields partial prerendering reads beyond the neutral registration. */
export type HoleRegistration = DynamicHole | SharedHole

export const isHole = (boundary: BoundaryRegistration): boundary is HoleRegistration =>
  boundary.mode === "dynamic" || boundary.mode === "shared"

/** What the page executor hands over for one PPR request. */
export interface PprRequest {
  readonly routeId: string
  /** The request's pathname, without search: the shell renders it, so it is part of the key. */
  readonly path: string
  readonly locale: string | undefined
  /** The declared variations this request selected, by name; part of the shell key. */
  readonly variations: Readonly<Record<string, string>>
  readonly request: Request
  /** The route's dynamic and shared boundaries, in declaration order, with their merged (guarded)
   * loaders. */
  readonly holes: readonly HoleRegistration[]
  readonly holeContext: Omit<BoundaryRequestCtx, "signal" | "live">
  /** What the shell loader and every shared hole loader get, but the build's signal. */
  readonly shellContext: Omit<ShellCtx, "signal">
  readonly loadShell: (signal: AbortSignal) => Promise<unknown>
  /** Render the full document for `shellData` with every hole pending, under no nonce. */
  readonly renderShellDocument: (shellData: unknown, states: BoundaryStates) => Promise<string>
  /** The route's `revalidate`, in seconds: an older shell is served while one rebuild runs. */
  readonly revalidate: number | undefined
  /** The route's `revalidateTags` for this request, read only when a shell is built. */
  readonly tags: () => readonly string[]
  /** A shared hole's `revalidateTags` for this request, read only when its entry is built. */
  readonly holeTags: (hole: SharedHole) => readonly string[]
  /** Keeps the platform alive for work that outlives the response, where the platform needs it. */
  readonly waitUntil?: ((promise: Promise<unknown>) => void) | undefined
  /** The client holds this route instance's hole hosts: a data request sends each hole's fill. */
  readonly fill?: boolean
  /** Holes the client keeps: none of them loads, and each state says it was kept. */
  readonly kept?: ReadonlySet<string>
  /** A live load: each hole's keys, and which holes loaded. */
  readonly live?: HoleLive
}

/** A live load's view of one response's holes. Owners are named by hole. */
export interface HoleLive {
  /** `ctx.live` for one hole's loader. */
  collector(hole: string): (...keys: string[]) => void
  /** Close one hole's collector once its loader settled. */
  seal(hole: string): void
  /** Called once, after every hole that ran settled, with the holes that loaded. */
  done(loaded: readonly string[]): void
}

/** The shell cannot be served now; the caller renders the page whole for this request. */
export class PprShellUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PprShellUnavailable"
  }
}

/** Thrown when a route's shell has no passing import-check record. */
export class PprShellUnchecked extends PprShellUnavailable {
  constructor(routeId: string) {
    super(
      `[nifra/web] ppr: route "${routeId}" has no passing shell import check; rendered blocking`,
    )
  }
}

/** Thrown when a route already runs `shellBuildConcurrency` shell builds: no request waits on one. */
export class PprShellBusy extends PprShellUnavailable {
  constructor(routeId: string) {
    super(`[nifra/web] ppr: route "${routeId}" is at its shell build limit; rendered blocking`)
  }
}

/** Thrown for a key seen fewer than `shellAfterRequests` times in a full store: the page streams whole. */
export class PprShellCold extends PprShellUnavailable {
  constructor(routeId: string) {
    super(`[nifra/web] ppr: route "${routeId}" has no shell for this key yet; rendered whole`)
  }
}

/**
 * How a response that is not a streamed document gets its holes. `"deferred"`: each hole runs under
 * admission and its own deadline, and its state carries the result as a deferred value (a soft
 * navigation's data request). `"settled"`: the same, awaited (the blocking render). `"omitted"`: no
 * hole runs and every state is an empty host (a prefetch, which must not start work its navigation
 * cannot cancel).
 */
export type HoleStatesMode = "deferred" | "settled" | "omitted"

export interface PprServerStats extends PprAdmissionStats {
  /** Responses aborted because unsent bytes went over `maxUnsentBytes` (`ppr.slow_aborted`). */
  readonly slowAborted: number
  /** Frame bytes queued for clients across every live PPR stream. */
  readonly unsentBytes: number
}

export interface PprServer {
  /** Stream one PPR document: the shared shell at once, then each hole as it settles. */
  respond(request: PprRequest): Promise<Response>
  /** The shell data a soft navigation's data request carries. */
  shellData(request: PprRequest): Promise<unknown>
  /** The hole states of a data request or a blocking render; `signal` is the request's. */
  holeStates(
    request: PprRequest,
    mode: HoleStatesMode,
    signal: AbortSignal,
  ): Promise<BoundaryStates>
  /** Abort the response that printed `token`. Unknown tokens do nothing. */
  cancel(token: string): boolean
  /**
   * Drop every shell carrying `tag`. A build that started before the call is not stored when it
   * finishes, so a shell built from data read before the purge never outlives it.
   */
  invalidateTag(tag: string): Promise<void>
  stats(): PprServerStats
}

/** What `createWebApp` gives a {@link PprSetup}: the parts of the app a PPR server depends on. */
export interface PprEnvironment {
  readonly adapter: RenderAdapter
  readonly csp?: CspPolicy
  /** Part of every shell key, so a shell built by one deployment is never served by another. */
  readonly deployment: string
  /** The app authorizes scripts with a per-request nonce, which would make every shell unique. */
  readonly perRequestNonce: boolean
}

/** One app's partial prerendering, as the page executor uses it. */
export interface PprIntegration {
  readonly server: PprServer
  /** The configured public origin a shell may use; never a visitor's Host. */
  readonly origin?: string
  /** Where the runtime's cancel beacon posts, and its handler. */
  readonly cancelPath: string
  cancel(request: Request): Promise<Response>
  /**
   * The streamed document, with the headers middleware and gates wrote, or how this request renders
   * whole instead: `"settled"` for a listed bot or a shell that is unchecked or at its build limit,
   * `"deferred"`, each hole streamed as it settles, for a key with no shell yet.
   */
  stream(
    request: PprRequest,
    written: () => Readonly<Record<string, string>> | undefined,
  ): Promise<Response | "settled" | "deferred">
  /** The shell data, or the shell loader's own output when the shell cannot be served now. */
  shellData(request: PprRequest, signal: AbortSignal): Promise<unknown>
  /** `variations` as the shell's own query string. */
  variationQuery(variations: Readonly<Record<string, string>>): string
  /** Throws for a route the plan's rules keep off the PPR path: its layouts, holes and their limits. */
  assertRoute(
    route: RouteEntry,
    layouts: LoadedLayoutModules,
    boundaries: readonly BoundaryRegistration[],
  ): void
  /** The declared variations `search` selects. */
  variationsOf(
    declared: RouteModule["shellVariations"],
    search: string,
  ): Readonly<Record<string, string>>
}

/** What `partialPrerendering()` returns for `createWebApp({ experimental: { ppr } })`. */
export interface PprSetup {
  readonly [PPR_SETUP]: (environment: PprEnvironment) => PprIntegration
}

/** `variations` as a query string, sorted by name: the shell key part and the shell's own search. */
export const variationQuery = (variations: Readonly<Record<string, string>>): string => {
  let query = ""
  for (const name of Object.keys(variations).sort()) {
    query += `${query === "" ? "" : "&"}${encodeURIComponent(name)}=${encodeURIComponent(variations[name] ?? "")}`
  }
  return query
}

// A browser's agent took the default rule about 0.5 us to test, and agents repeat. The bounds keep a
// client that sends a new agent per request from growing the map.
const MAX_REMEMBERED_AGENT = 256
const MAX_REMEMBERED_AGENTS = 1024
const agentAnswers = new WeakMap<RegExp, Map<string, boolean>>()

/** Whether `request` gets the blocking render under `options`. */
export function wantsBlockingRender(options: ResolvedPprOptions, request: Request): boolean {
  const rule = options.blockingFor
  if (typeof rule === "function") return rule(request)
  const agent = request.headers.get("user-agent")
  if (agent === null) return false
  if (agent.length > MAX_REMEMBERED_AGENT) return rule.test(agent)
  let answers = agentAnswers.get(rule)
  if (answers === undefined) {
    answers = new Map()
    agentAnswers.set(rule, answers)
  }
  let answer = answers.get(agent)
  if (answer === undefined) {
    if (answers.size >= MAX_REMEMBERED_AGENTS) answers.clear()
    // No `g` or `y` flag (options refuse them), so a test reads no state and an answer holds.
    answer = rule.test(agent)
    answers.set(agent, answer)
  }
  return answer
}
