/**
 * Node-direct outcome shaping: the `@nifrajs/node` bridge's render form and the `Response` -> outcome
 * conversion. Mirrors `respond.ts` but skips the undici `Response` build where the adapter can write a
 * plain-data render straight to the socket. Imports only runtime-core + respond + the spine types.
 */
import {
  appendCookiesToResponse,
  markTaggedResponse,
  normalizeBodylessResponse,
  rememberMutableHeaders,
  taggedResponseBody,
} from "./respond.ts"
import { type HandlerResult, isResponseResult } from "./runtime-core.ts"
import type { CtxSet } from "./server.ts"

function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304
}

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
      /** Header record after native hooks; repeated values are retained as arrays. */
      readonly headers: Readonly<Record<string, string | readonly string[]>> | undefined
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
        body: isBodylessStatus(body.status) ? new Uint8Array(0) : body.body,
      }
    }
    return nodeOutcomeFromResponse(
      appendCookiesToResponse(normalizeBodylessResponse(result.toResponse()), set),
    )
  }
  if (result instanceof Response) {
    return nodeOutcomeFromResponse(appendCookiesToResponse(normalizeBodylessResponse(result), set))
  }
  const status = set.status ?? (result === undefined ? 204 : 200)
  return {
    kind: "json",
    status,
    headers: set._headers,
    cookies: set._cookies,
    body: result === undefined || isBodylessStatus(status) ? null : JSON.stringify(result),
  }
}

/**
 * Materialize a buffered node outcome only when a Web `onResponse` hook needs to see a real
 * `Response`. The marker lets an in-place hook (`response.headers.set(...); return response`) go back
 * to the direct socket writer without draining the body through a Web stream. A hook that replaces,
 * consumes, or otherwise changes the response naturally loses the marker and stays on the portable
 * response path.
 */
export function nodeOutcomeToResponse(outcome: NodeServeOutcome): Response {
  if (outcome.kind === "response") return outcome.response
  // A prebuilt `Headers` on purpose: undici's Response constructor takes a fast clone path for a
  // `Headers` instance, which measured cheaper than handing it a pairs list to fill (pairs pay a
  // webidl sequence conversion per entry).
  const headers = new Headers()
  if (outcome.headers !== undefined) {
    for (const [name, value] of Object.entries(outcome.headers)) {
      if (typeof value !== "string") {
        for (const item of value) headers.append(name, item)
      } else {
        headers.set(name, value as string)
      }
    }
  }
  if (outcome.kind === "json") {
    if (outcome.cookies !== undefined) {
      for (const cookie of outcome.cookies) headers.append("set-cookie", cookie)
    }
    if (outcome.body !== null && headers.get("content-type") === null) {
      headers.set("content-type", "application/json;charset=utf-8")
    }
  }
  if (isBodylessStatus(outcome.status)) headers.delete("content-length")
  const body = isBodylessStatus(outcome.status) ? null : outcome.body
  // `Uint8Array<ArrayBufferLike>` vs the lib's body-init generic - runtime-accepted everywhere,
  // only the type narrows wrong under the DOM-free lib set (same idiom as the Headers cast in
  // transport-codec.ts).
  const response = new Response(body as ConstructorParameters<typeof Response>[0], {
    status: outcome.status,
    headers,
  })
  if (body !== null) markTaggedResponse(response, body)
  rememberMutableHeaders(response.headers)
  return response
}

export function nodeOutcomeFromResponse(response: Response): NodeServeOutcome {
  response = normalizeBodylessResponse(response)
  const body = nodeResponseBody(response)
  return body === undefined
    ? { kind: "response", response }
    : { kind: "body", status: response.status, headers: responseHeadersForNode(response), body }
}

function nodeResponseBody(response: Response): string | Uint8Array | undefined {
  if (response.bodyUsed) return undefined
  return taggedResponseBody(response)
}

function responseHeadersForNode(
  response: Response,
): Readonly<Record<string, string | readonly string[]>> | undefined {
  let headers: Record<string, string | readonly string[]> | undefined
  response.headers.forEach((value, key) => {
    headers ??= Object.create(null) as Record<string, string | readonly string[]>
    headers[key] = value
  })
  const setCookies = response.headers.getSetCookie?.()
  if (setCookies !== undefined && setCookies.length > 0) {
    headers ??= Object.create(null) as Record<string, string | readonly string[]>
    headers["set-cookie"] = setCookies
  }
  return headers
}

function appendCookiesToNodeHeaders(
  headers: Readonly<Record<string, string | readonly string[]>> | undefined,
  cookies: readonly string[] | undefined,
): Readonly<Record<string, string | readonly string[]>> | undefined {
  if (cookies === undefined || cookies.length === 0) return headers
  const out = Object.create(null) as Record<string, string | readonly string[]>
  if (headers !== undefined) Object.assign(out, headers)
  const existing = out["set-cookie"]
  const setCookies =
    existing === undefined ? [] : typeof existing === "string" ? [existing] : [...existing]
  out["set-cookie"] = [...setCookies, ...cookies]
  return out
}
