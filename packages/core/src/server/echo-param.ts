import { decodePathSegment } from "../router/path-codec.ts"

const HEADERS = { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" }
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Answer 200 with the route's last path parameter as plain text, exactly as the request spelled it:
 * percent-escapes are left in, not decoded. `get("/user/:id", echoParam("id"))` answers
 * `/user/%41b` with `%41b`.
 *
 * The raw spelling is the contract because a transport can then answer the route itself (uWS fills the
 * body in from the path without calling into JavaScript), and every runtime agrees on the bytes. A
 * parameter that is not the last segment, or a segment of dots written as percent-escapes (a URL
 * parser reads `%2E` as a dot segment), answers with the decoded value.
 */
export function echoParam<const Name extends string>(
  name: Name,
): (context: {
  readonly params: { readonly [K in Name]: string }
  readonly req: Request
}) => Response {
  if (!NAME.test(name))
    throw new TypeError(`echoParam: ${JSON.stringify(name)} is not a parameter name`)
  const handler = (context: {
    readonly params: { readonly [K in Name]: string }
    readonly req: Request
  }): Response => {
    const url = context.req.url
    const query = url.search(/[?#]/)
    const path = query === -1 ? url : url.slice(0, query)
    const raw = path.slice(path.lastIndexOf("/") + 1)
    const decoded = context.params[name]
    // The raw spelling is the last segment's, so the parameter must be the route's last one.
    const keys = Object.keys(context.params)
    const last = keys[keys.length - 1] === name && decodePathSegment(raw) === decoded
    return new Response(last ? raw : decoded, { headers: HEADERS })
  }
  Object.defineProperty(handler, Symbol.for("@nifrajs/core/echo-param"), { value: name })
  return Object.freeze(handler)
}
