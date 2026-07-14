/**
 * Explicit in-process backend mount seam shared by `@nifrajs/client` and `@nifrajs/web`.
 *
 * A symbol key keeps the mount control path separate from the typed route proxy: an application may
 * legitimately expose a `/fetch` or `/mount` route without shadowing this interface. The handler gets
 * the same platform object as the outer app, so Workers bindings and execution lifetime survive an
 * in-process mount.
 */

import type { Platform } from "./server/context.ts"

/** Global symbol so independently bundled copies of core/client/web still agree on the mount seam. */
export const NIFRA_BACKEND_MOUNT = Symbol.for("@nifrajs/backend-mount")

/** Dispatch one already-materialized request into a backend with its outer runtime platform context. */
export type BackendMountHandler<Env = unknown> = (
  request: Request,
  platform?: Platform<Env>,
) => Response | Promise<Response>

/** Structural mount capability exposed by an in-process typed client. */
export interface BackendMount<Env = unknown> {
  readonly [NIFRA_BACKEND_MOUNT]: BackendMountHandler<Env>
}
