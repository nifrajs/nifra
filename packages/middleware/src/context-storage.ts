import { AsyncLocalStorage } from "node:async_hooks"
import type { Context, Middleware } from "@nifrajs/core/server"

// Created on first use: a module with no top-level work is dropped from a bundle that imports it
// without calling it, which is how a partially prerendered shell's import check tells the two apart.
let storage: AsyncLocalStorage<Context> | undefined

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
      storage ??= new AsyncLocalStorage<Context>()
      return storage.run(context, next)
    },
  }
}

/** Return the current request context, or throw when no context-storage wrapper is active. */
export function getContext<C extends Context = Context>(): C {
  const context = tryGetContext<C>()
  if (context === undefined) {
    throw new Error(
      "contextStorage: no active context. Add app.use(contextStorage()) before the route and call getContext() during that request. A partially prerendered shell is built outside every request: read the request in a dynamic boundary's loader instead.",
    )
  }
  return context
}

/** Return the current request context, or `undefined` outside a context-storage request. */
export function tryGetContext<C extends Context = Context>(): C | undefined {
  return storage?.getStore() as C | undefined
}
