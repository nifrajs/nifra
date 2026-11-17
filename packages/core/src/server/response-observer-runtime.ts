import { tagSource } from "../internal/hook-origins.ts"
import type {
  NodeRequestContext,
  NodeResponseBodyHook,
  NodeResponseHook,
  RenderBodyHook,
  RenderHeadersView,
  ResponseBodyHook,
  ResponseHeadersHook,
  ResponseHeadersView,
} from "./node-outcome-hook.ts"
import { recordHeadersView } from "./node-outcome-hook.ts"
import { type RenderJson, tagged, taggedResponseBody, writableResponse } from "./respond.ts"
import { applyBodyReplacement, withReplacedBody } from "./response-hooks.ts"
import { JSON_CONTENT_TYPE } from "./runtime-core.ts"

type MaybePromise<T> = T | Promise<T>
type WebResponseHook = (response: Response, req: Request) => MaybePromise<Response>

export type {
  NodeResponseBodyHook,
  RenderBodyHook,
  RenderHeadersView,
  ResponseBodyHook,
  ResponseHeadersHook,
} from "./node-outcome-hook.ts"

// Deno reports `process.env` reads as `NotCapable` without --allow-env; read it only off Deno.
declare const Deno: unknown

export interface ResponseObserverHost {
  assertConfigurable(operation: string): void
  addResponseHook(
    web: WebResponseHook,
    node: NodeResponseHook | undefined,
    headerOnly?: boolean,
    render?: RenderJson,
  ): void
  enableResponseBodyTagging(): object
  responseBodyOwners(): ReadonlySet<object>
  /** A render-time body hook threw: report it. The reply falls back to `onResponseBody`. */
  renderFailed(error: unknown, request: Request): void
}

export interface ResponseObserverMethods {
  /**
   * Register a portable header hook. `node` is an optional equivalent for the Node-direct record;
   * it must preserve the portable hook's observable header semantics.
   */
  onResponseHeaders(fn: ResponseHeadersHook, node?: NodeResponseHook): this
  onResponseBody(fn: ResponseBodyHook, node?: NodeResponseBodyHook, render?: RenderBodyHook): this
  onResponseRaw(fn: (response: Response, req: Request) => MaybePromise<Response>): this
}

export interface ResponseObserverRuntime {
  install(host: ResponseObserverHost): ResponseObserverMethods
}

function webRequestView(req: Request): NodeRequestContext {
  return { method: req.method, url: req.url, header: (name) => req.headers.get(name) }
}

function webHeadersView(
  response: Response,
  req: Request,
): {
  readonly response: Response
  readonly headers: ResponseHeadersView
  readonly request: NodeRequestContext
} {
  const writable = writableResponse(response, req)
  return { response: writable, headers: writable.headers, request: webRequestView(req) }
}

/** The header view a {@link RenderBodyHook} writes: the plain record the reply is about to be built
 * from. Writes are noted so a render that changed nothing can take the plain path. */
class RenderHeaders implements RenderHeadersView {
  touched = false
  constructor(readonly record: Record<string, string>) {}
  get(name: string): string | null {
    const lower = name.toLowerCase()
    // Own names only: a plain record would answer `constructor` with a function.
    return Object.hasOwn(this.record, lower) ? (this.record[lower] ?? null) : null
  }
  has(name: string): boolean {
    return Object.hasOwn(this.record, name.toLowerCase())
  }
  set(name: string, value: string): void {
    this.touched = true
    this.record[name.toLowerCase()] = value
  }
  delete(name: string): void {
    this.touched = true
    delete this.record[name.toLowerCase()]
  }
}

/**
 * A rendered JSON value built through a body hook's render fast path, as ONE `Response`: the hook sees
 * the text before any `Response` exists, and its bytes and headers go straight into the one built
 * here, where the body tier builds the rendered response and then a replacement for it. `undefined`
 * when the hook left both the body and the headers alone.
 */
/** Replies sent straight to `onResponseBody` after a render failure before the fast path is tried
 * again. High enough that a hook that keeps failing costs one throw and one log line per 100,000
 * replies, low enough that a one-off failure (memory pressure) does not outlive the traffic burst. */
export const RENDER_RETRY_AFTER = 100_000

function renderThrough(render: RenderBodyHook, host: ResponseObserverHost): RenderJson {
  // Replies still to hand to `onResponseBody` before the next try, so a failing hook does not throw
  // and log on every request.
  let skip = 0
  return (body, status, request, unstamped, owner) => {
    if (skip > 0) {
      skip--
      return undefined
    }
    const record: Record<string, string> = { "content-type": JSON_CONTENT_TYPE }
    const headers = new RenderHeaders(record)
    let bytes: Uint8Array | undefined
    try {
      bytes = render(
        body,
        headers,
        { method: request.method, url: request.url, header: (name) => request.headers.get(name) },
        status,
      )
    } catch (error) {
      // The lane's own catch would answer a bare 500 that finalization never hears about. Declining
      // hands the reply to `onResponseBody`, which fails through the response pipeline as it always has.
      skip = RENDER_RETRY_AFTER
      host.renderFailed(error, request)
      return undefined
    }
    if (bytes === undefined && !headers.touched) return undefined
    const payload = bytes ?? body
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a Uint8Array is a valid BodyInit; only the lib's ArrayBufferLike variance rejects it.
    const init = payload as ConstructorParameters<typeof Response>[0]
    // Rendered only when the hook produced the final bytes: one that merely touched the headers
    // (a `Vary` on a reply it left whole) still has its body hook to run.
    return tagged(
      new Response(init, { status, headers: record }),
      payload,
      owner,
      unstamped,
      bytes !== undefined,
    )
  }
}

export function createResponseObserverRuntime(): ResponseObserverRuntime {
  return {
    install(host) {
      return {
        onResponseHeaders(
          this: ResponseObserverMethods,
          fn: ResponseHeadersHook,
          node?: NodeResponseHook,
        ): ResponseObserverMethods {
          host.assertConfigurable("onResponseHeaders()")
          const web: Parameters<typeof host.addResponseHook>[0] = (response, req) => {
            const view = webHeadersView(response, req)
            const out = fn(view.headers, view.request, response.status)
            return out instanceof Promise ? out.then(() => view.response) : view.response
          }
          // Development-only provenance for `reflectHooks`; a production define folds it away.
          if (typeof Deno === "undefined" && process.env.NODE_ENV !== "production")
            tagSource(web, fn)
          host.addResponseHook(
            web,
            node ?? ((response, req) => fn(recordHeadersView(response), req, response.status)),
            true,
          )
          return this
        },
        onResponseBody(
          this: ResponseObserverMethods,
          fn: ResponseBodyHook,
          node?: NodeResponseBodyHook,
          render?: RenderBodyHook,
        ): ResponseObserverMethods {
          host.assertConfigurable("onResponseBody()")
          host.enableResponseBodyTagging()
          host.addResponseHook(
            (response, req) => {
              const body = taggedResponseBody(response, host.responseBodyOwners())
              if (body === undefined) return response
              const view = webHeadersView(response, req)
              const out = fn(body, view.headers, view.request, response.status)
              return out instanceof Promise
                ? out.then((replaced) => withReplacedBody(response, replaced))
                : withReplacedBody(response, out)
            },
            (response, req) => {
              if (response.body === null) return undefined
              // An author-supplied twin sees the same bytes and returns through the same
              // replacement channel; only the header-view allocation is skipped.
              const out =
                node === undefined
                  ? fn(response.body, recordHeadersView(response), req, response.status)
                  : node(response.body, response, req, response.status)
              if (out instanceof Promise)
                return out.then((replaced) => applyBodyReplacement(response, replaced))
              applyBodyReplacement(response, out)
              return undefined
            },
            false,
            render === undefined ? undefined : renderThrough(render, host),
          )
          return this
        },
        onResponseRaw(this: ResponseObserverMethods, fn): ResponseObserverMethods {
          host.assertConfigurable("onResponseRaw()")
          host.enableResponseBodyTagging()
          host.addResponseHook(
            (response, req) =>
              taggedResponseBody(response, host.responseBodyOwners()) === undefined
                ? fn(response, req)
                : response,
            () => undefined,
            false,
          )
          return this
        },
      }
    },
  }
}
