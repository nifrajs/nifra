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

/** Produces token-only route/evidence facts; it is never called from request dispatch. */
export type BackendEvidenceProvider = () =>
  | ProjectEvidenceSnapshot
  | Promise<ProjectEvidenceSnapshot>

/** Structural mount capability exposed by an in-process typed client. */
export interface BackendMount<Env = unknown> {
  readonly [NIFRA_BACKEND_MOUNT]: BackendMountHandler<Env>
  readonly [NIFRA_BACKEND_WS_MOUNT]?: BackendWebSocketMountHandler<Env>
  readonly [NIFRA_BACKEND_WS_RUNTIME]?: BackendWebSocketRuntimeProvider
  readonly [NIFRA_BACKEND_EVIDENCE]?: BackendEvidenceProvider
}
