import { carryRequestLocals, replacedRequestOf, requestLocal } from "@nifrajs/core/server"

interface RequestDependencyState {
  headersRead: boolean
}

const dependencyByRequest = requestLocal<RequestDependencyState>()
const requestHeaderReadsBeforeRoute = requestLocal<boolean>()
const instrumentedRequests = new WeakMap<Request, RequestDependencyState>()
export const OWNER_REQUEST_HEADER_DEPENDENCY_HEADER = "x-nifra-owner-request-header-dependency"

const trackedHeaderMethods: ReadonlySet<PropertyKey> = new Set([
  "append",
  "delete",
  "entries",
  "forEach",
  "get",
  "getSetCookie",
  "has",
  "keys",
  "set",
  "values",
])

function instrumentHeaders(request: Request, state: RequestDependencyState): void {
  const headers = request.headers
  const view = new Proxy(headers, {
    get(target, property) {
      const method = Reflect.get(target, property, target)
      if (
        typeof method !== "function" ||
        (!trackedHeaderMethods.has(property) && property !== Symbol.iterator)
      )
        return method
      return (...args: unknown[]) => {
        state.headersRead = true
        return Reflect.apply(method, target, args)
      }
    },
  })
  Object.defineProperty(request, "headers", {
    configurable: true,
    get: () => view,
  })
}

function trackRequest(request: Request, state: RequestDependencyState): Request {
  dependencyByRequest.set(request, state)
  instrumentedRequests.set(request, state)
  instrumentHeaders(request, state)

  Object.defineProperty(request, "clone", {
    configurable: true,
    value: () => {
      const copy = new Request(request, { signal: request.signal })
      carryRequestLocals(request, copy)
      return trackRequest(copy, state)
    },
  })
  return request
}

/** Instrument the exact request for response hooks, which cannot receive a replacement request. */
export function trackRequestHeaderReadsInPlace(request: Request): void {
  if (instrumentedRequests.has(request)) return
  const state: RequestDependencyState = { headersRead: false }
  try {
    trackRequest(request, state)
  } catch {
    state.headersRead = true
    dependencyByRequest.set(request, state)
    instrumentedRequests.set(request, state)
  }
}

/** Give route code a brand-preserving request view that records header dependencies. */
export function trackRequestHeaderReads(request: Request): Request {
  const existing = instrumentedRequests.get(request)
  if (existing !== undefined) return request

  const state: RequestDependencyState = { headersRead: false }
  dependencyByRequest.set(request, state)
  try {
    const view = new Request(request, { signal: request.signal })
    carryRequestLocals(request, view)
    return trackRequest(view, state)
  } catch {
    // An unreadable body or runtime-specific clone failure must opt out of shared caching.
    state.headersRead = true
    instrumentedRequests.set(request, state)
    return request
  }
}

/** Unknown request views fail closed because their header reads could not be observed. */
export function requestHeadersWereRead(request: Request): boolean {
  let current: Request | undefined = request
  const visited = new Set<Request>()
  let observed = false
  while (current !== undefined) {
    if (visited.has(current)) return true
    visited.add(current)
    const beforeRoute = requestHeaderReadsBeforeRoute.get(current)
    if (beforeRoute !== undefined) {
      observed = true
      if (beforeRoute) return true
    }
    const state = instrumentedRequests.get(current)
    if (state !== undefined) {
      observed = true
      if (state.headersRead) return true
    } else if (beforeRoute === undefined) {
      // A replacement or copy that lost the tracked view cannot prove which headers were read.
      return true
    }
    current = replacedRequestOf(current)
  }
  return !observed
}

/** Snapshot user middleware reads and restore native Request behavior before framework internals run. */
export function finishRequestHeaderTrackingInPlace(request: Request): void {
  const headersRead = requestHeadersWereRead(request)
  try {
    if (!Reflect.deleteProperty(request, "headers"))
      throw new TypeError("headers view is not removable")
    if (!Reflect.deleteProperty(request, "clone"))
      throw new TypeError("clone view is not removable")
    dependencyByRequest.delete(request)
    instrumentedRequests.delete(request)
    requestHeaderReadsBeforeRoute.set(request, headersRead)
  } catch {
    // A runtime-specific Request that cannot be restored stays tracked and disables shared storage.
    requestHeaderReadsBeforeRoute.set(request, true)
  }
}
