import { INSTALL_RESPONSE_OBSERVER } from "./server/install.ts"
import {
  createResponseObserverRuntime,
  type ResponseObserverRuntime,
} from "./server/response-observer-runtime.ts"
import type { AnyServer } from "./server/server.ts"

export type {
  ResponseBodyHook,
  ResponseHeadersHook,
  ResponseObserverMethods,
  ResponseObserverRuntime,
} from "./server/response-observer-runtime.ts"

/** A server shape with the opt-in response observation methods installed. */
export type ResponseObserverServer<S extends AnyServer> = S &
  import("./server/response-observer-runtime.ts").ResponseObserverMethods

/** A plugin that enables response header, body, and raw-response observation methods. */
export type ResponseObserverPlugin = (<S extends AnyServer>(
  app: S,
) => ResponseObserverServer<S>) & { readonly pluginName?: string }

/**
 * Enable the response observation methods on a server.
 *
 * The default server does not carry the header, body, or raw-response observation adapters. Apply
 * this plugin before using those methods:
 *
 * ```ts
 * import { responseObserver } from "@nifrajs/core/response-observer"
 * const app = server().use(responseObserver()).onResponseHeaders((headers) => {
 *   headers.set("cache-control", "no-store")
 * })
 * ```
 */
export function responseObserver(): ResponseObserverPlugin {
  const apply = <S extends AnyServer>(app: S): ResponseObserverServer<S> => {
    const install = (app as unknown as Record<symbol, unknown>)[INSTALL_RESPONSE_OBSERVER]
    if (typeof install !== "function") {
      throw new TypeError("[nifra] responseObserver() requires a compatible Server")
    }
    const methods = (install as (runtime: ResponseObserverRuntime) => unknown).call(
      app,
      createResponseObserverRuntime(),
    )
    if (methods === null || typeof methods !== "object") {
      throw new TypeError("[nifra] responseObserver() failed to install its methods")
    }
    Object.assign(app, methods)
    return app as ResponseObserverServer<S>
  }
  return Object.assign(apply, { pluginName: "nifra:response-observer" })
}

/** Attach the opt-in observer runtime to a middleware bundle that uses response observation. */
export function withResponseObserver<T extends object>(middleware: T): T {
  Object.defineProperty(middleware, INSTALL_RESPONSE_OBSERVER, {
    value: createResponseObserverRuntime(),
    enumerable: false,
    configurable: false,
  })
  return middleware
}
