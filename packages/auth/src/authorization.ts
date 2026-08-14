/**
 * Public authorization seam. Nifra supplies the control-flow contract; the application or data layer
 * supplies the actual policy. No subject/resource data is persisted or interpreted here.
 */
import { status } from "@nifrajs/core/server"

/** What a policy is asked to decide: this subject, doing this action, optionally to this resource. */
export interface AuthorizationRequest<Subject = unknown, Resource = unknown> {
  readonly subject: Subject
  readonly action: string
  readonly resource?: Resource
}

export type Authorizer<Subject = unknown, Resource = unknown> = (
  request: AuthorizationRequest<Subject, Resource>,
) => boolean | Promise<boolean>

/** Evaluate a policy, failing closed for any non-true result. */
export async function isAuthorized<Subject, Resource>(
  authorizer: Authorizer<Subject, Resource>,
  request: AuthorizationRequest<Subject, Resource>,
): Promise<boolean> {
  return (await authorizer(request)) === true
}

/** Require an application/data-layer policy to allow an action. A denied request throws a plain
 * `status(403)` render - the same control-flow signal a guard throws, on the same rendering lane as a
 * returned one, so the denial never builds a `Response`. Like the guards, it throws because it is
 * called for effect from inside the work it protects; where the caller can return, return
 * `status(403, ...)` instead. */
export async function requireAuthorization<Subject, Resource>(
  authorizer: Authorizer<Subject, Resource>,
  request: AuthorizationRequest<Subject, Resource>,
): Promise<void> {
  if (await isAuthorized(authorizer, request)) return
  throw status(403, { ok: false, error: "forbidden" })
}
