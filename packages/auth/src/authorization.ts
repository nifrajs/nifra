/**
 * Public authorization seam. Nifra supplies the control-flow contract; the application or data layer
 * supplies the actual policy. No subject/resource data is persisted or interpreted here.
 */
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

/** Require an application/data-layer policy to allow an action; denied requests throw a 403 Response. */
export async function requireAuthorization<Subject, Resource>(
  authorizer: Authorizer<Subject, Resource>,
  request: AuthorizationRequest<Subject, Resource>,
): Promise<void> {
  if (await isAuthorized(authorizer, request)) return
  throw Response.json({ ok: false, error: "forbidden" }, { status: 403 })
}
