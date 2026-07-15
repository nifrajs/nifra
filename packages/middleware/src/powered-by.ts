import type { Middleware } from "@nifrajs/core/server"
import { withHeaders } from "./_utils.ts"

export interface PoweredByOptions {
  /** Header name. Default `"x-powered-by"`. */
  readonly header?: string
  /** Header value. Default `"Nifra"`. */
  readonly value?: string
  /** Do not overwrite an existing header by default. */
  readonly respectExisting?: boolean
}

/**
 * Opt-in `X-Powered-By` style header. Nifra does not emit this by default; use it only when you want a
 * public framework/product marker.
 */
export function poweredBy(options: PoweredByOptions = {}): Middleware {
  const header = options.header ?? "x-powered-by"
  const value = options.value ?? "Nifra"
  const respectExisting = options.respectExisting !== false
  if (header.trim() === "") throw new Error("poweredBy: header is empty")
  if (/[\r\n]/.test(value)) throw new Error("poweredBy: value contains a newline")

  return {
    name: "powered-by",
    onResponse(res) {
      if (respectExisting && res.headers.has(header)) return res
      return withHeaders(res, (headers) => headers.set(header, value))
    },
  }
}
