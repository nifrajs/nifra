/**
 * undici-backed transport for `createProxy` - the fast upstream path on Node.
 *
 * `fetch()` is a spec-compliant wrapper over the same client. Measured against a local origin at 50
 * concurrent connections, going straight to undici's dispatcher API instead is roughly 2.5x the
 * throughput on GET and 2.2x on POST; on Bun there is no such gap, so this is a Node remedy and the
 * default `fetch` transport stays the portable one.
 *
 * The security obligations in {@link ProxyTransport} are met here as follows: undici does not follow
 * redirects unless asked to, so a 3xx is relayed and the upstream can never steer the next hop; the
 * URL is passed through untouched, so the dialed host is still the one `createProxy` computed; and
 * TLS verification is left alone, with no option offered to weaken it. Sanitised headers are
 * forwarded exactly as handed over.
 *
 * The redirect guarantee is the one a caller can break: undici 8 moved redirect following into an
 * opt-in interceptor (undici 7 spelled it `maxRedirections`, defaulting to none). Composing a
 * redirect interceptor into a `dispatcher` passed here would defeat it, and this transport cannot
 * detect that. Do not.
 *
 * ```ts
 * import { createProxy } from "@nifrajs/proxy"
 * import { undiciTransport } from "@nifrajs/proxy/undici"
 *
 * const proxy = createProxy({ upstream: "http://127.0.0.1:8081", transport: undiciTransport() })
 * ```
 *
 * Requires `undici` (>= 7) to be installed; it is an optional peer, so the base package stays
 * dependency-free for everyone who does not opt in.
 */

import { Readable } from "node:stream"
import { type Dispatcher, request as undiciRequest } from "undici"
import type { ProxyTransport, ProxyUpstreamResponse } from "./index.ts"

export interface UndiciTransportOptions {
  /**
   * Connection pool to dial through - an undici `Agent`, `Pool`, or any other `Dispatcher`. Omit to
   * use undici's global dispatcher. Supply one to tune `connections` per origin, which is the knob
   * that matters under load. It must not compose a redirect interceptor: this proxy relays 3xx
   * rather than following it, and a dispatcher that follows would hand the upstream the next hop.
   */
  readonly dispatcher?: Dispatcher
  /**
   * Milliseconds of silence tolerated *within* the response body before undici destroys it.
   * `createProxy`'s own `timeoutMs` only covers the wait for response headers - after the status is
   * relayed a `504` is no longer sendable - so this is what protects against a body that starts and
   * then stalls. Default `30_000`; `0` disables it.
   */
  readonly bodyTimeoutMs?: number
}

/**
 * Statuses that MUST NOT carry a body. `fetch` reports `response.body === null` for these, but
 * undici hands back a real (empty) stream, and `new Response(stream, { status: 204 })` throws. The
 * stream is dumped rather than dropped, because an unread undici body holds its socket open.
 */
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 204, 205, 304])

function toHeaders(raw: Readonly<Record<string, string | string[] | undefined>>): Headers {
  const out = new Headers()
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const entry of value) out.append(name, entry)
    } else {
      out.append(name, value)
    }
  }
  return out
}

/** Create an undici-backed {@link ProxyTransport}. */
export function undiciTransport(options: UndiciTransportOptions = {}): ProxyTransport {
  // Under Bun the `undici` specifier resolves to a built-in shim whose response bodies have no
  // `dump()` and whose request bodies undici cannot iterate - every POST and every bodiless status
  // would come back as a flat 502. Fail at construction instead: there is nothing to gain anyway,
  // since Bun's own fetch measures level with a raw client, and the default transport is faster.
  if (typeof (globalThis as { readonly Bun?: unknown }).Bun !== "undefined") {
    throw new Error(
      "[nifra/proxy] undiciTransport() is a Node remedy - under Bun the `undici` specifier resolves to a built-in shim this cannot drive, and Bun's own fetch shows no gap. Leave `transport` unset there.",
    )
  }
  const bodyTimeout = options.bodyTimeoutMs ?? 30_000
  if (!Number.isFinite(bodyTimeout) || bodyTimeout < 0) {
    throw new Error("[nifra/proxy] bodyTimeoutMs must be a non-negative number")
  }
  const dispatcher = options.dispatcher

  return async (target, request): Promise<ProxyUpstreamResponse> => {
    // Flat name/value pairs preserve what `Headers` already merged, without a second object.
    const headers: string[] = []
    for (const [name, value] of request.headers) headers.push(name, value)

    const response = await undiciRequest(target, {
      method: request.method as Dispatcher.HttpMethod,
      headers,
      // Node's own stream type, so undici never has to guess how to consume it.
      body: request.body === null ? null : Readable.fromWeb(request.body),
      signal: request.signal,
      bodyTimeout,
      ...(dispatcher === undefined ? {} : { dispatcher }),
    })

    if (NULL_BODY_STATUS.has(response.statusCode) || request.method === "HEAD") {
      await response.body.dump()
      return {
        status: response.statusCode,
        statusText: "",
        headers: toHeaders(response.headers),
        body: null,
      }
    }

    return {
      status: response.statusCode,
      statusText: "",
      headers: toHeaders(response.headers),
      body: Readable.toWeb(response.body) as ReadableStream<Uint8Array>,
    }
  }
}
