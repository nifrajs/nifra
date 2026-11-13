/**
 * The seam a sibling HTTP adapter builds on (`@nifrajs/node-uws`): the node-direct outcome runtime a
 * nifra app answers through, the Host and target policy `serve()` applies, and the app's lifecycle and
 * error hooks. Not part of the app-facing API - `serve()` is.
 */
import { serve } from "./index.ts"

export type { NodeServeOutcome } from "./generated/node-outcome.ts"

/** The Host and target options `serve()` accepts, resolved once at startup. */
export interface HostPolicy {
  readonly allowedHosts: ReadonlySet<string> | ((host: string) => boolean) | undefined
  readonly canonicalHost: string | undefined
  readonly normalizeTarget: boolean
}

export interface HostPolicyOptions {
  readonly allowedHosts?: readonly string[] | ((host: string) => boolean)
  readonly canonicalHost?: string
  readonly normalizeTarget?: boolean
}

interface TransportKit {
  readonly runtime: object
  enableNodeDirect(app: object): void
  activateAsyncContextFrame(): void
  errorReporterOf(app: object): ((error: unknown) => void) | undefined
  lifecycleOf(app: object): (phase: "stopping" | "stopped") => Promise<void>
  hostPolicyOf(options: HostPolicyOptions): HostPolicy
  resolveRequestHost(host: string | null | undefined, policy: HostPolicy): string | undefined
  resolveRequestTarget(target: string, normalizeTarget: boolean): string
}

// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: index.ts defines this property on `serve` with exactly the TransportKit shape
const kit = Reflect.get(serve, Symbol.for("@nifrajs/node/transport-kit")) as TransportKit

/** Handed to `app.resolveNodeSource(source, platform, runtime)`; opaque to the transport. */
export const nodeOutcomeRuntime: object = kit.runtime

/** Install the app's node-direct hooks (a no-op for a plain `{ fetch }` handler or an already-served app). */
export const enableNodeDirect: (app: object) => void = kit.enableNodeDirect

/** Node's async-context bookkeeping flips on lazily; flipping it before listening keeps the tick loop monomorphic. */
export const activateAsyncContextFrame: () => void = kit.activateAsyncContextFrame

/** The app's own error log, when it has one. */
export const errorReporterOf: (app: object) => ((error: unknown) => void) | undefined =
  kit.errorReporterOf

/** The app's `onStopping` / `onStop` hooks as one function; a no-op for a plain handler. */
export const lifecycleOf: (app: object) => (phase: "stopping" | "stopped") => Promise<void> =
  kit.lifecycleOf

/** Validate and normalize `allowedHosts` / `canonicalHost` / `normalizeTarget`; throws a `TypeError` on a malformed entry. */
export const hostPolicyOf: (options: HostPolicyOptions) => HostPolicy = kit.hostPolicyOf

/** The authority a request is answered as, or `undefined` to refuse it with 400. `null` means Host repeated. */
export const resolveRequestHost: (
  host: string | null | undefined,
  policy: HostPolicy,
) => string | undefined = kit.resolveRequestHost

/** The origin-form target the app routes on: absolute-form unwrapped, dot segments resolved when asked. */
export const resolveRequestTarget: (target: string, normalizeTarget: boolean) => string =
  kit.resolveRequestTarget

/** How `stop()` winds the server down; the same shape `serve()` takes in `@nifrajs/node`. */
export interface NodeStopOptions {
  readonly drainMs?: number
  readonly delayMs?: number
}
