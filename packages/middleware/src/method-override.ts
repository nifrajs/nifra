import { definePlugin, METHODS, type Method } from "@nifrajs/core"
import { jsonError } from "./_utils.ts"

export interface MethodOverrideOptions {
  /**
   * Header carrying the desired method. Default `"x-http-method-override"`.
   * Set `false` to disable header-based override.
   */
  readonly header?: string | false
  /**
   * Query parameter carrying the desired method. Disabled by default because query-tunneled writes are
   * easier to trigger accidentally from links/forms. Use only with CSRF protection on browser routes.
   */
  readonly query?: string | false
  /** Original request methods allowed to tunnel. Default `["POST"]`. */
  readonly methods?: readonly string[]
  /** Target methods accepted from the override source. Default `["PUT", "PATCH", "DELETE"]`. */
  readonly allowed?: readonly Method[]
  /** Invalid override values reject with `400` by default. Use `"ignore"` for legacy clients. */
  readonly onInvalid?: "reject" | "ignore"
}

const SUPPORTED = new Set<string>(METHODS)
const DEFAULT_ALLOWED = ["PUT", "PATCH", "DELETE"] as const

function normalizeMethod(value: string): Method | null {
  const method = value.trim().toUpperCase()
  if (!SUPPORTED.has(method)) return null
  return method as Method
}

function singleQueryValue(req: Request, name: string): string | null | false {
  const values = new URL(req.url).searchParams.getAll(name)
  if (values.length === 0) return null
  if (values.length > 1) return false
  return values[0] ?? null
}

function replacement(req: Request, method: Method): Request {
  return new Request(req, { method })
}

/**
 * HTTP method override for clients that can only send `POST`. The middleware rewrites the request
 * before routing, so handlers, validation, and response hooks all see the overridden method.
 *
 * Header override is enabled by default; query override is opt-in. Form-body override is deliberately
 * not implemented because reading the body before routing would consume or buffer it for every write.
 */
export function methodOverride(options: MethodOverrideOptions = {}) {
  const header = options.header === undefined ? "x-http-method-override" : options.header
  const query = options.query ?? false
  const sourceMethods = new Set((options.methods ?? ["POST"]).map((m) => m.toUpperCase()))
  const allowed = new Set<Method>(options.allowed ?? DEFAULT_ALLOWED)
  const rejectInvalid = options.onInvalid !== "ignore"

  if (header !== false && header.trim() === "") throw new Error("methodOverride: header is empty")
  if (query !== false && query.trim() === "") throw new Error("methodOverride: query is empty")

  return definePlugin("methodOverride", (app) =>
    app.onRequest((req) => {
      if (!sourceMethods.has(req.method.toUpperCase())) return undefined

      const values: string[] = []
      if (header !== false) {
        const value = req.headers.get(header)
        if (value !== null) values.push(value)
      }
      if (query !== false) {
        const value = singleQueryValue(req, query)
        if (value === false)
          return rejectInvalid ? jsonError(400, "invalid_method_override") : undefined
        if (value !== null) values.push(value)
      }
      if (values.length === 0) return undefined
      if (values.length > 1 && new Set(values.map((v) => v.trim().toUpperCase())).size > 1) {
        return rejectInvalid ? jsonError(400, "invalid_method_override") : undefined
      }

      const method = normalizeMethod(values[0] ?? "")
      if (method === null || !allowed.has(method)) {
        return rejectInvalid ? jsonError(400, "invalid_method_override") : undefined
      }
      return method === req.method ? undefined : replacement(req, method)
    }),
  )
}
