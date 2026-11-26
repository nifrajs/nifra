// The work every `raw-*` target does, written once so each engine answers the same three routes with the
// same checks and the same bytes. No router, no hooks, no content-type check: just the routes' logic.
const JSON_TYPE = "application/json"
const decoder = new TextDecoder()

/** `[status, contentType, body]` for a request, or `undefined` for a path no route serves. */
export function handle(method, path, bodyText) {
  if (method === "GET") {
    if (path.startsWith("/user/") && path.length > 6) {
      const segment = path.slice(6)
      if (!segment.includes("/")) return [200, JSON_TYPE, `{"id":${JSON.stringify(segment)}}`]
    }
    if (path === "/ping") return [200, "text/plain", "ok"]
  } else if (method === "POST" && path === "/users") {
    try {
      const parsed = JSON.parse(bodyText ?? "")
      if (typeof parsed?.name !== "string") throw new TypeError("name")
      return [200, JSON_TYPE, JSON.stringify({ ok: true, name: parsed.name })]
    } catch {
      return [400, JSON_TYPE, '{"error":"bad_request"}']
    }
  }
  return [404, JSON_TYPE, '{"error":"not_found"}']
}

export const decode = (bytes) => (bytes === null ? "" : decoder.decode(bytes))
