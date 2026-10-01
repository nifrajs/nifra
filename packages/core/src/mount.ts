/**
 * Explicit in-process backend mount seam shared by `@nifrajs/client` and `@nifrajs/web`.
 *
 * A symbol key keeps the mount control path separate from the typed route proxy: an application may
 * legitimately expose a `/fetch` or `/mount` route without shadowing this interface. The handler gets
 * the same platform object as the outer app, so Workers bindings and execution lifetime survive an
 * in-process mount.
 */

import type { ProjectEvidenceSnapshot } from "./evidence.ts"
import type { Platform } from "./server/context.ts"
import type { WebSocketUpgradeOutcome } from "./server/websocket.ts"

/** Global symbol so independently bundled copies of core/client/web still agree on the mount seam. */
export const NIFRA_BACKEND_MOUNT = Symbol.for("@nifrajs/backend-mount")

/** Optional symbol-keyed upgrade seam carried by an in-process client mount. */
export const NIFRA_BACKEND_WS_MOUNT = Symbol.for("@nifrajs/backend-ws-mount")

/** Internal runtime-provider seam used when an in-process WebSocket backend is mounted in Bun. */
export const NIFRA_BACKEND_WS_RUNTIME = Symbol.for("@nifrajs/backend-ws-runtime")

/** Optional offline assurance/evidence seam for composed applications. */
export const NIFRA_BACKEND_EVIDENCE = Symbol.for("@nifrajs/backend-evidence")

/**
 * Optional request-scoping seam carried by an in-process typed client. Called with one request's
 * {@link Platform}, it returns a view of the same typed client whose calls dispatch with that platform,
 * so a backend reached from an SSR loader sees the page visitor's `c.clientIp`, `c.env` and
 * `c.waitUntil`. The view carries platform fields only - never the page request's headers.
 */
export const NIFRA_BACKEND_BIND_PLATFORM = Symbol.for("@nifrajs/backend-bind-platform")

export { NIFRA_PLATFORM_CLIENT_IP_DERIVED } from "./server/client-ip.ts"

/** Dispatch one already-materialized request into a backend with its outer runtime platform context. */
export type BackendMountHandler<Env = unknown> = (
  request: Request,
  platform?: Platform<Env>,
) => Response | Promise<Response>

/** Adapter-neutral WebSocket upgrade resolver for a mounted backend. */
export type BackendWebSocketMountHandler<Env = unknown> = (
  request: Request,
  platform?: Platform<Env>,
) => WebSocketUpgradeOutcome | Promise<WebSocketUpgradeOutcome>

/** Opaque provider kept structural so public mount types do not expose the WS runtime internals. */
export type BackendWebSocketRuntimeProvider = () => unknown

/** Returns a view of an in-process typed client bound to one request's platform. */
export type BackendPlatformBinder<Env = unknown> = (platform: Platform<Env>) => unknown

/** Produces token-only route/evidence facts; it is never called from request dispatch. */
export type BackendEvidenceProvider = () =>
  | ProjectEvidenceSnapshot
  | Promise<ProjectEvidenceSnapshot>

/**
 * The path of every pre-route `mount()` on a nifra server, as the server matches it (`"/"` for a root
 * mount). Such a mount answers every request under its path before the app's own routes run, and
 * `fallbackOn: 404` only moves on to the next mount, so a route the app declares there is unreachable.
 * Reads the server's own mount table, as `reflectMounts` does; a value that is not a nifra server
 * yields `[]`. Never called from request dispatch.
 */
export function preRouteMountPaths(app: unknown): readonly string[] {
  const mounts = (app as { readonly fetchMounts?: unknown } | null | undefined)?.fetchMounts
  if (!Array.isArray(mounts)) return []
  const paths: string[] = []
  for (const mount of mounts as ReadonlyArray<{
    readonly path?: unknown
    readonly beforeRoutes?: unknown
  } | null>) {
    if (mount?.beforeRoutes === true && typeof mount.path === "string") paths.push(mount.path)
  }
  return paths
}

/** Structural mount capability exposed by an in-process typed client. */
export interface BackendMount<Env = unknown> {
  readonly [NIFRA_BACKEND_MOUNT]: BackendMountHandler<Env>
  readonly [NIFRA_BACKEND_WS_MOUNT]?: BackendWebSocketMountHandler<Env>
  readonly [NIFRA_BACKEND_WS_RUNTIME]?: BackendWebSocketRuntimeProvider
  readonly [NIFRA_BACKEND_EVIDENCE]?: BackendEvidenceProvider
  readonly [NIFRA_BACKEND_BIND_PLATFORM]?: BackendPlatformBinder<Env>
}
