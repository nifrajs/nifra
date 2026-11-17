import { decodePathSegment } from "../router/path-codec.ts"

const HEADERS = { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" }

/** A static prefix and one final `:name` segment: `/user/:id`, `/:id`. */
const LAST_PARAM = /^(?:\/[^/:*?]+)*\/:([A-Za-z_][A-Za-z0-9_]*)$/

/** The path of a request URL, query and fragment dropped. */
const pathOf = (url: string): string => {
  const start = url.indexOf("/", url.indexOf("//") + 2)
  const end = url.search(/[?#]/)
  return url.slice(start === -1 ? url.length : start, end === -1 ? url.length : end)
}

/**
 * Answer 200 with the route's final path parameter as plain text, exactly as the request spelled it:
 * percent-escapes are left in, not decoded. Pass the route's own path:
 *
 *     const USER = "/user/:id"
 *     server().get(USER, echoParam(USER))
 *
 * `/user/%41b` answers `%41b`. The path is a static prefix followed by one `:name` segment; anything
 * else throws, so the parameter is always the last segment.
 *
 * The raw spelling is the contract because a transport can then answer the route itself (uWS fills the
 * body in from the path without calling into JavaScript), and every runtime agrees on the bytes. Where
 * the raw spelling cannot be told, a segment of dots written as percent-escapes (a URL parser reads
 * `%2E` as a dot segment) or a route registered under another path, the decoded value is answered.
 */
export function echoParam(
  path: string,
): (context: {
  readonly params: Readonly<Record<string, string>>
  readonly req: Request
}) => Response {
  const name = LAST_PARAM.exec(path)?.[1]
  if (name === undefined) {
    throw new TypeError(
      `echoParam: ${JSON.stringify(path)} must be a static prefix and a final :name segment, like "/user/:id"`,
    )
  }
  const depth = path.split("/").length
  const handler = (context: {
    readonly params: Readonly<Record<string, string>>
    readonly req: Request
  }): Response => {
    const segments = pathOf(context.req.url).split("/")
    const raw = segments.length === depth ? segments[depth - 1] : undefined
    const decoded = context.params[name] ?? ""
    return new Response(raw !== undefined && decodePathSegment(raw) === decoded ? raw : decoded, {
      headers: HEADERS,
    })
  }
  Object.defineProperty(handler, Symbol.for("@nifrajs/core/echo-param"), { value: path })
  return Object.freeze(handler)
}
