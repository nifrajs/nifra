import type { NodeResponseContext, ResponseBodyReplacement } from "./node-outcome-hook.ts"
import { markTaggedResponse, taggedResponseBody, taggedResponseOwner } from "./respond.ts"

export function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304
}

/** Apply a body hook's return to the native response outcome. */
export function applyBodyReplacement(
  response: NodeResponseContext,
  replaced: string | Uint8Array | ResponseBodyReplacement | undefined,
): void {
  if (replaced === undefined) return
  if (typeof replaced === "string" || replaced instanceof Uint8Array) {
    response.body = isBodylessStatus(response.status) ? null : replaced
    return
  }
  if (replaced.body !== undefined) response.body = replaced.body
  if (replaced.status !== undefined) response.status = replaced.status
  if (isBodylessStatus(response.status)) response.body = null
}

/**
 * Swap a tagged Response's body for a hook's replacement, re-tagging so later body hooks and the Node
 * fallback's direct writer see the new bytes. Explicit lengths are dropped so framing is re-derived.
 */
export function withReplacedBody(
  response: Response,
  replaced: string | Uint8Array | ResponseBodyReplacement | undefined,
): Response {
  if (replaced === undefined) return response
  const originalBody = taggedResponseBody(response)
  let body: string | Uint8Array | null
  let status = response.status
  if (typeof replaced === "string" || replaced instanceof Uint8Array) {
    body = replaced
  } else {
    body = replaced.body !== undefined ? replaced.body : (originalBody ?? null)
    if (replaced.status !== undefined) status = replaced.status
    if (body === (originalBody ?? null) && status === response.status) return response
  }
  if (isBodylessStatus(status)) body = null
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  const next = new Response(body as ConstructorParameters<typeof Response>[0], {
    status,
    headers,
  })
  if (body !== null) markTaggedResponse(next, body, taggedResponseOwner(response))
  return next
}
