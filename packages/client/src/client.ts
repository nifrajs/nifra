import type { ContractShape, RegistryFor } from "@nifrajs/core"
import type { ApiError, Result } from "./result.ts"
import type { Treaty, TreatyFromRegistry } from "./treaty.ts"

const HTTP_VERBS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
])
const BODY_VERBS: ReadonlySet<string> = new Set(["post", "put", "patch"])

/**
 * The fetch shape the client needs — looser than `typeof fetch` so an in-process bridge or a
 * test mock satisfies it without the extra members (`.preconnect`, overloads) of the global.
 */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface ClientOptions {
  /** Headers sent on every request (a per-call `headers` option is merged on top). */
  readonly headers?: Record<string, string>
  /** Override the `fetch` implementation (tests, an in-process bridge, a custom agent, etc.). */
  readonly fetch?: FetchFn
}

interface CallOptions {
  readonly query?: Record<string, unknown>
  readonly headers?: Record<string, string>
  readonly signal?: AbortSignal
}

/**
 * Create an end-to-end-typed client for a nifra server. Two modes:
 *
 *   // coupled — typed from the server's type (`typeof app`)
 *   const api = client<typeof app>("http://localhost:3000")
 *
 *   // decoupled — typed from a contract VALUE, no server import
 *   const api = client(contract, "https://api.example.com")
 *
 *   const { data, error } = await api.users({ id: "1" }).get()
 *
 * Both return the same Eden-style proxy. Browser-safe: uses only `fetch` /
 * `Proxy` / `URL`, never the server runtime. Never throws — network and non-2xx
 * responses surface as a `Result` `error`.
 */
export function client<App>(baseUrl: string, options?: ClientOptions): Treaty<App>
export function client<const C extends ContractShape>(
  contract: C,
  baseUrl: string,
  options?: ClientOptions,
): TreatyFromRegistry<RegistryFor<C>>
export function client(
  arg1: string | ContractShape,
  arg2?: string | ClientOptions,
  arg3?: ClientOptions,
): unknown {
  const baseUrl = typeof arg1 === "string" ? arg1 : (arg2 as string)
  const options = (typeof arg1 === "string" ? (arg2 as ClientOptions | undefined) : arg3) ?? {}
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl
  // The contract value (decoupled mode) is only a type carrier here; the runtime
  // proxy needs just the base URL. (Client-side validation from the contract's
  // schemas is a future enhancement.)
  return createProxy(base, "", options)
}

/**
 * A {@link client} whose `fetch` calls a nifra app's own `fetch` in-process — no network, full
 * lifecycle (validation, middleware, contracts). For SSR loaders. Typed from `App` exactly like
 * the network client. The `(url, init) → Request` bridge is required because the client calls
 * `fetch(url, init)` while `app.fetch` takes a `Request`.
 */
export function inProcessClient<
  App extends { fetch(request: Request): Response | Promise<Response> },
>(app: App, options?: Omit<ClientOptions, "fetch">): Treaty<App> {
  return client<App>("http://nifra.internal", {
    ...options,
    fetch: (url, init) => Promise.resolve(app.fetch(new Request(url, init))),
  })
}

/**
 * The in-process test client — the Fastify-`inject` / supertest equivalent for nifra. Drives the
 * app's own `fetch` directly: no server, no port, no network, the full real lifecycle (validation,
 * middleware, contracts, auth), and end-to-end types from `App`. Calls never throw — branch on
 * `res.ok`. An alias of {@link inProcessClient} with a test-focused name; identical behavior.
 *
 * ```ts
 * import { testClient } from "@nifrajs/client"
 * import { app } from "../src/app"
 *
 * const api = testClient<typeof app>(app)
 * const res = await api.users({ id: "42" }).get()
 * expect(res.ok && res.data.id).toBe("42")
 * ```
 */
export const testClient = inProcessClient

function createProxy(base: string, path: string, options: ClientOptions): unknown {
  const target = (): void => {}
  return new Proxy(target, {
    get(_target, key) {
      // `then` guard: keep an un-awaited node proxy from looking like a thenable.
      if (typeof key !== "string" || key === "then") return undefined
      if (HTTP_VERBS.has(key.toLowerCase())) {
        return (...args: unknown[]): Promise<Result<unknown>> =>
          execute(base, path, key.toLowerCase(), args, options)
      }
      // `index` addresses the root path "/" and adds no segment.
      return createProxy(base, key === "index" ? path : `${path}/${key}`, options)
    },
    apply(_target, _thisArg, args) {
      // A param call (`api.users({ id })`): append the single value, encoded — encoding "/"
      // round-trips through the server's decode, so wildcards and params share this one path.
      // The Treaty type requires the object, but the runtime must stay graceful: a no-arg call
      // (`api.users()`) or empty object (`api.users({})`) must NOT throw — the client's contract is
      // to never throw — nor synthesize an `"undefined"` path segment. With no value, fall through
      // to the bare path, which the server resolves as an ordinary `{ ok: false }` (404) Result.
      const first = args[0]
      const value =
        first !== null && typeof first === "object"
          ? Object.values(first as Record<string, unknown>)[0]
          : first
      if (value === undefined || value === null) return createProxy(base, path, options)
      return createProxy(base, `${path}/${encodeURIComponent(String(value))}`, options)
    },
  })
}

async function execute(
  base: string,
  path: string,
  verb: string,
  args: unknown[],
  options: ClientOptions,
): Promise<Result<unknown>> {
  const isBodyVerb = BODY_VERBS.has(verb)
  const body = isBodyVerb ? args[0] : undefined
  const callOptions = (isBodyVerb ? args[1] : args[0]) as CallOptions | undefined

  let url = base + (path === "" ? "/" : path)
  const query = callOptions?.query ? buildQuery(callOptions.query) : ""
  if (query !== "") url += `?${query}`

  const headers: Record<string, string> = { ...options.headers, ...callOptions?.headers }
  const init: RequestInit = { method: verb.toUpperCase(), headers }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    headers["content-type"] = "application/json"
  }
  if (callOptions?.signal) init.signal = callOptions.signal

  const doFetch = options.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(url, init)
  } catch {
    return { ok: false, status: 0, data: null, error: { error: "network_error" } }
  }

  const data = await parseBody(response)
  if (response.ok) {
    return { ok: true, status: response.status, data, error: null }
  }
  return { ok: false, status: response.status, data: null, error: toApiError(data) }
}

function buildQuery(query: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  return params.toString()
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const text = await response.text()
  if (text === "") return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text // a non-JSON body (e.g. a plain-text Response) is returned as-is
  }
}

function toApiError(data: unknown): ApiError {
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "string"
  ) {
    // Trust the server's `{ error, issues }` shape (it's what nifra emits).
    const issues =
      "issues" in data && Array.isArray(data.issues)
        ? (data.issues as ApiError["issues"])
        : undefined
    return issues !== undefined ? { error: data.error, issues } : { error: data.error }
  }
  return { error: "request_failed" }
}
