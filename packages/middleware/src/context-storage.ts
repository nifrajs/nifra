import { AsyncLocalStorage } from "node:async_hooks"
import type { Context, Middleware } from "@nifrajs/core/server"

const storage = new AsyncLocalStorage<Context>()

/**
 * Store the current nifra `Context` in `AsyncLocalStorage` for helpers that run away from the handler
 * argument, e.g. repository/logger functions called deep in the stack.
 *
 * Import from `@nifrajs/middleware/context-storage` so ordinary `@nifrajs/middleware` imports stay
 * node-compat-free on edge runtimes. The runtime must support `node:async_hooks` AsyncLocalStorage.
 */
export function contextStorage(): Middleware {
  return {
    name: "context-storage",
    around(context, next) {
      return storage.run(context, next)
    },
  }
}

/** Return the current request context, or throw when no context-storage wrapper is active. */
export function getContext<C extends Context = Context>(): C {
  const context = tryGetContext<C>()
  if (context === undefined) {
    throw new Error(
      "contextStorage: no active context. Add app.use(contextStorage()) before the route and call getContext() during that request.",
    )
  }
  return context
}

/** Return the current request context, or `undefined` outside a context-storage request. */
export function tryGetContext<C extends Context = Context>(): C | undefined {
  return storage.getStore() as C | undefined
}
