/**
 * Node-direct outcome shaping: the `@nifrajs/node` bridge's render form and the `Response` -> outcome
 * conversion. Mirrors `respond.ts` but skips the undici `Response` build where the adapter can write a
 * plain-data render straight to the socket. Imports only runtime-core + respond + the spine types.
 */
import { appendCookiesToResponse } from "./respond.ts"
import { type HandlerResult, isResponseResult } from "./runtime-core.ts"
import type { CtxSet } from "./server.ts"

/**
 * What {@link Server.resolveNode} returns: either a plain-data render the `@nifrajs/node` adapter writes
 * to the socket directly (`kind: "json"` - status + headers + cookies + a pre-stringified body, **no**
 * undici `Response` built or drained), a marked buffered response body (`kind: "body"` - e.g.
 * @nifrajs/web's non-deferred SSR HTML), or a `Response` (`kind: "response"`) for everything else
 * (redirects, 404/405/errors, unmarked or streaming bodies). Internal to the nifra<->node bridge.
 */
export type NodeServeOutcome =
  | { readonly kind: "response"; readonly response: Response }
  | {
      readonly kind: "json"
      readonly status: number
      /** `c.set.headers` backing, or `undefined` when the handler never set a header. */
      readonly headers: Readonly<Record<string, string>> | undefined
      /** Queued `Set-Cookie` lines, or `undefined`; the adapter emits one header line each. */
      readonly cookies: readonly string[] | undefined
      /** The JSON body already stringified, or `null` for an empty (204) response. */
      readonly body: string | null
    }
  | {
      readonly kind: "body"
      readonly status: number
      readonly headers: Readonly<Record<string, string | readonly string[]>> | undefined
      readonly body: string | Uint8Array
    }

/**
 * `finalize` for the node-direct path - mirror of `toResponse` that skips the `Response` build:
 * a plain value becomes pre-stringified JSON primitives (the adapter `JSON.stringify`s once, here, not
 * via `Response.json` + a body drain); a handler-returned `Response` is wrapped as-is, with queued
 * cookies appended exactly as `toResponse` does (so the set-cookie-then-`redirect()` pattern still
 * works on Node).
 */
export function toNodeOutcome(result: HandlerResult, set: CtxSet): NodeServeOutcome {
  if (isResponseResult(result)) {
    const body = result.toNodeBody?.()
    if (body !== undefined) {
      return {
        kind: "body",
        status: body.status,
        headers: appendCookiesToNodeHeaders(body.headers, set._cookies),
        body: body.body,
      }
    }
    return nodeOutcomeFromResponse(appendCookiesToResponse(result.toResponse(), set))
  }
  if (result instanceof Response) {
    return nodeOutcomeFromResponse(appendCookiesToResponse(result, set))
  }
  const status = set.status ?? (result === undefined ? 204 : 200)
  return {
    kind: "json",
    status,
    headers: set._headers,
    cookies: set._cookies,
    body: result === undefined ? null : JSON.stringify(result),
  }
}

const NODE_RESPONSE_BODY = Symbol.for("nifra.response.body")

export function nodeOutcomeFromResponse(response: Response): NodeServeOutcome {
  const body = nodeResponseBody(response)
  return body === undefined
    ? { kind: "response", response }
    : { kind: "body", status: response.status, headers: responseHeadersForNode(response), body }
}

function nodeResponseBody(response: Response): string | Uint8Array | undefined {
  if (response.bodyUsed) return undefined
  const body = (response as { readonly [NODE_RESPONSE_BODY]?: unknown })[NODE_RESPONSE_BODY]
  return typeof body === "string" || body instanceof Uint8Array ? body : undefined
}

function responseHeadersForNode(
  response: Response,
): Readonly<Record<string, string | readonly string[]>> | undefined {
  let headers: Record<string, string | readonly string[]> | undefined
  response.headers.forEach((value, key) => {
    headers ??= {}
    headers[key] = value
  })
  const setCookies = response.headers.getSetCookie?.()
  if (setCookies !== undefined && setCookies.length > 0) {
    headers ??= {}
    headers["set-cookie"] = setCookies
  }
  return headers
}

function appendCookiesToNodeHeaders(
  headers: Readonly<Record<string, string | readonly string[]>> | undefined,
  cookies: readonly string[] | undefined,
): Readonly<Record<string, string | readonly string[]>> | undefined {
  if (cookies === undefined || cookies.length === 0) return headers
  const out: Record<string, string | readonly string[]> =
    headers === undefined ? {} : { ...headers }
  const existing = out["set-cookie"]
  const setCookies =
    existing === undefined ? [] : typeof existing === "string" ? [existing] : [...existing]
  out["set-cookie"] = [...setCookies, ...cookies]
  return out
}
