/** Each request an `onRequest` hook returned in place of the one it was handed, mapped to that one. */
const REPLACED = new WeakMap<Request, Request>()

export function recordRequestReplacement(replacement: Request, replaced: Request): void {
  REPLACED.set(replacement, replaced)
}

/**
 * The request an `onRequest` hook returned this one in place of, or `undefined` for the request the
 * exchange began with. Response hooks receive the request the route ran with, so a middleware that
 * keyed state on the request its `onRequest` saw walks back from there to find it.
 */
export function replacedRequestOf(request: Request): Request | undefined {
  return REPLACED.get(request)
}
