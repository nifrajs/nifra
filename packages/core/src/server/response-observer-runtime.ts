import type {
  NodeRequestContext,
  NodeResponseBodyHook,
  NodeResponseHook,
  ResponseBodyHook,
  ResponseHeadersHook,
  ResponseHeadersView,
} from "./node-outcome-hook.ts"
import { recordHeadersView } from "./node-outcome-hook.ts"
import { taggedResponseBody, writableResponse } from "./respond.ts"
import { applyBodyReplacement, withReplacedBody } from "./response-hooks.ts"

type MaybePromise<T> = T | Promise<T>
type WebResponseHook = (response: Response, req: Request) => MaybePromise<Response>

export type {
  NodeResponseBodyHook,
  ResponseBodyHook,
  ResponseHeadersHook,
} from "./node-outcome-hook.ts"

export interface ResponseObserverHost {
  assertConfigurable(operation: string): void
  addResponseHook(
    web: WebResponseHook,
    node: NodeResponseHook | undefined,
    headerOnly?: boolean,
  ): void
  enableResponseBodyTagging(): object
  responseBodyOwners(): ReadonlySet<object>
}

export interface ResponseObserverMethods {
  /**
   * Register a portable header hook. `node` is an optional equivalent for the Node-direct record;
   * it must preserve the portable hook's observable header semantics.
   */
  onResponseHeaders(fn: ResponseHeadersHook, node?: NodeResponseHook): this
  onResponseBody(fn: ResponseBodyHook, node?: NodeResponseBodyHook): this
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
          host.addResponseHook(
            (response, req) => {
              const view = webHeadersView(response, req)
              const out = fn(view.headers, view.request, response.status)
              return out instanceof Promise ? out.then(() => view.response) : view.response
            },
            node ?? ((response, req) => fn(recordHeadersView(response), req, response.status)),
            true,
          )
          return this
        },
        onResponseBody(
          this: ResponseObserverMethods,
          fn: ResponseBodyHook,
          node?: NodeResponseBodyHook,
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
