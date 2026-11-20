/**
 * Feature-area entries for the failures nifra throws about its own configuration and inputs. Each
 * names the rule that was broken, from the messages the framework raises; the message itself carries
 * the specifics (which option, which path). Kept apart from the catalog so that file stays the list
 * of failures with a distinctive shape.
 */
import { type CatalogEntry, nifraOwned } from "./diagnostic-entry.ts"

export const FAMILY_ENTRIES: readonly CatalogEntry[] = [
  {
    code: "NIFRA_HEADER_VALUE_INVALID",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^(?:\[nifra\] cookie |responseHeaders:|poweredBy: value|multipartResponse: part headers|staticResponse cannot set|Invalid character in header|\[nifra\/web\] redirect location contains|\[nifra\/web\] ctx\.set\.headers: |og image: .* contains a control character)/,
      ),
    cause:
      "A response header or cookie value was refused: a control character, a newline, a leading or trailing space, an illegal character in a cookie Domain or Path, a `__Host-` cookie with a Domain, a cookie over its size limit, or a framing header set statically.",
    fix: "The message names the header or cookie. Remove the character it names, and set per-response headers with c.set.headers (cookies with c.set.cookie) instead of statically.",
    docsAnchor: "errors#header-value-invalid",
  },
  {
    code: "NIFRA_CSP_CONFIG",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^\[nifra\/web\] (?:createWebApp `cspHeader`|createNonceResolver|CSP policy used before|executable inline scripts?|an executable inline script|head\.script only|refusing executable content|unsupported executable script)/,
      ),
    cause:
      "The Content-Security-Policy or inline-script setup conflicts: a cspHeader and a nonce resolver both writing the header, an executable inline script without a nonce, content the inert head.script slot refuses, or a policy used before it was prepared.",
    fix: "The message names the conflict. Use either `nonce` or `csp: createCspPolicy(...)`, give executable scripts a non-empty nonce, and use unsafeInlineScript() only where the message says to.",
    docsAnchor: "errors#csp-config",
  },
  {
    code: "NIFRA_CDN_CONFIG",
    match: (_n, m) => /^\[nifra\/web\/cdn\] /.test(m),
    cause:
      "A CDN adapter was given a missing binding or a store that cannot do what was asked (for example invalidate by tag), or an option outside what it accepts.",
    fix: "The message names the adapter and what to pass (the `cache` binding, the @vercel/functions helper, a store that supports tags). Pass it where the CDN is configured.",
    docsAnchor: "errors#cdn-config",
  },
  {
    code: "NIFRA_PARITY_FAILED",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^\[nifra\] (?:identity parity|development and production manifest parity)/,
      ),
    cause:
      "The development/production parity check failed (identity parity or manifest parity), or its scan hit the limit before it could decide.",
    fix: "Read the differences the message lists and make development and production agree. When the scan limit was reached, narrow the scan by running from the app or workspace root.",
    docsAnchor: "errors#parity-failed",
  },
  {
    code: "NIFRA_API_MISUSE",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^(?:around next\(\) called multiple times|\[nifra\] c\.req\.body was read as a stream|\[nifra\] a Response body can be sent only once|\[nifra\/web\] ctx\.set\..* was used after the response was committed|\[nifra\/web\] ctx\.live\(\) was called|\[nifra\/proxy\] undiciTransport|\[nifra\/web\/ppr\] pprShells|\[nifra\/auth\] .*: session was not created by this manager|\[nifra\/web\] a server component rendered no|a server component rendered no HTML|notFound\(\)|idempotency: the route ran on an unprepared request|mount .* declares .* twice|\[nifra\/web\] a server component hole renders on the server only|.* called with no query client|cannot mark an idempotent request safe to retry)/,
      ),
    cause:
      "An API was called in a state it does not allow: next() called twice, a request body read as a stream after it was consumed, a response body sent twice, headers written after the response was committed, notFound() applied twice or inside a group, or a query used with no query client.",
    fix: "The message names the call. Call it once, before the response is committed, and on the object it belongs to (read bodies with c.req.bytes() in a hook; apply notFound() to the parent server).",
    docsAnchor: "errors#api-misuse",
  },
  {
    code: "NIFRA_WEBSOCKET_INVALID",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^(?:ws\.close\(\):|cannot open a WebSocket at a path|the in-process client cannot open WebSockets|\[nifra\/core\] a path segment cannot )/,
      ),
    cause:
      "A WebSocket was opened or closed in a way the protocol or the client does not allow: a close reason over 123 UTF-8 bytes, a close code a server may not send, a path with a dot segment, or an in-process client that has no socket.",
    fix: "Close with a reason of at most 123 bytes and a code in 1000-1003, 1007-1014 or 3000-4999. Open sockets against a listening app, at a path without `.` or `..` segments.",
    docsAnchor: "errors#websocket-invalid",
  },
  {
    code: "NIFRA_VALUE_NOT_SERIALIZABLE",
    match: (n, m, fromNifra) =>
      n === "WireEncodeError" ||
      nifraOwned(
        m,
        fromNifra,
        /^(?:cyclic value|non-JSON value|non-finite number|non-plain object|undefined (?:array item|object field)|canonical JSON cannot encode|Converting circular structure to JSON|Do not know how to serialize a BigInt|Could not serialize JSON\.rawJSON|no JSON number source text)/,
      ),
    cause:
      "A value could not be turned into JSON or the typed wire: a circular reference, a BigInt, a non-finite number, a class instance, an undefined field or array item, or a type the wire has no encoding for.",
    fix: "Send plain data: objects, arrays, strings, finite numbers and booleans. Convert BigInt and class instances to plain values before they cross the boundary.",
    docsAnchor: "errors#value-not-serializable",
  },
  {
    code: "NIFRA_CRON_INVALID",
    match: (n, m) => n === "CronError" || /^\[nifra\/cron\] /.test(m),
    cause:
      "A cron schedule or job registration is invalid: not five space-separated fields, an empty, out-of-range or malformed term, or two jobs with the same name.",
    fix: "Write the schedule as five space-separated fields with each value in its range, and register each job name once.",
    docsAnchor: "errors#cron-invalid",
  },
  {
    code: "NIFRA_GRAPHQL_REQUEST",
    match: (n, m, fromNifra) =>
      (fromNifra && n === "GraphQLError") || nifraOwned(m, fromNifra, /^mountGraphql:/),
    cause:
      "A GraphQL request was malformed (no `query`, a body that is not a JSON object, variables that are not a JSON object), or mountGraphql was configured in a way it refuses.",
    fix: "For a request, send a JSON object with a `query` string and an object for `variables`. For mountGraphql, call `.use(websocket())` before enabling subscriptions, and guard sockets with the same authorization as the HTTP endpoint.",
    docsAnchor: "errors#graphql-request",
  },
  {
    code: "NIFRA_IMAGE_INVALID",
    match: (n, m, fromNifra) =>
      n === "ImageProcessingError" || nifraOwned(m, fromNifra, /^(?:\[nifra\/image\]|og image:)/),
    cause:
      "An image could not be processed or generated: a source that failed to decode or changed while it was being opened, variants without positive dimensions, or generated output over its size limit.",
    fix: "The message names the step. Give the image a valid source and positive dimensions, and keep generated output within maxBytes.",
    docsAnchor: "errors#image-invalid",
  },
  {
    code: "NIFRA_HTTP_RESPONSE_INVALID",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^(?:Invalid status code|response body is (?:longer|shorter) than its Content-Length|Invalid character in header|request closed before body completed|\[nifra\] request body stream yielded)/,
      ),
    cause:
      "The server adapter could not write or read the HTTP message: a status code outside the valid range, a body whose length disagrees with its Content-Length, an invalid header character, or a request that closed early.",
    fix: "Return a valid status, send a body that matches the Content-Length you set (or omit it), and keep header names and values to legal characters.",
    docsAnchor: "errors#http-response-invalid",
  },
  {
    code: "NIFRA_OPTION_RENAMED",
    match: (n, m, fromNifra) =>
      (n === "TypeError" || n === "Error") &&
      (fromNifra || /^\[nifra/.test(m)) &&
      /`[\w.]+` is now `[\w.]+`/.test(m),
    cause: "An option was renamed in this version, and the old name is no longer read.",
    fix: "The message gives the new name. Rename the option where you pass it.",
    docsAnchor: "errors#option-renamed",
  },
  {
    code: "NIFRA_CLIENT_REFUSED",
    match: (n, m, fromNifra) =>
      n === "ResponseContractViolation" ||
      nifraOwned(
        m,
        fromNifra,
        /^(?:sse_event_too_large|sse_http_|Cannot send ".*" in a form body)/,
      ),
    cause:
      "The typed client refused a response or a request: a response that breaks the route's declared contract, a server-sent event over its size limit, or a form field that is neither text nor a file.",
    fix: "For a contract violation, make the server return what its route declares (or update the declaration). For a form body, send strings and files only.",
    docsAnchor: "errors#client-refused",
  },
  {
    code: "NIFRA_TOOL_INVALID",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^(?:tool (?:contract|conformance|idempotency|budget|\S+:)|durable adapter conformance|runToolCli:|approval (?:decision|store))/,
      ),
    cause:
      "A tool declaration, its adapter, or its approval or budget settings break a rule: an option of the wrong type, a limit exceeded, a missing approval, or a duplicate tool name.",
    fix: "The message names the tool and the field. Correct the declaration; `nifra check` reports the same project-wide.",
    docsAnchor: "errors#tool-invalid",
  },
  {
    code: "NIFRA_JWKS_UNAVAILABLE",
    match: (_n, m, fromNifra) =>
      nifraOwned(m, fromNifra, /^jwks: (?:fetch failed|response|invalid set|url must be https)/),
    cause:
      "The JWKS endpoint used to verify tokens could not be used: the fetch failed, the response could not be read or was over its size limit, the key set was invalid, or the URL is not https.",
    fix: "The message gives the status or reason. Check that the JWKS URL is reachable over https (localhost is allowed) and returns a valid key set within maxBytes.",
    docsAnchor: "errors#jwks-unavailable",
  },
  {
    code: "NIFRA_BODY_PARSER_REFUSED",
    match: (_n, m, fromNifra) => nifraOwned(m, fromNifra, /^bodyParser: "/),
    cause:
      "bodyParser was given a media type nifra already handles (JSON, a form, multipart) or one a browser can send from any site without a preflight request.",
    fix: "The message names the media type and what to do instead: body schemas already read JSON and forms, multipart uses multipartBody from @nifrajs/core/multipart, and a no-preflight type must be read in the handler.",
    docsAnchor: "errors#body-parser-refused",
  },
  {
    code: "NIFRA_IDEMPOTENCY_STORE_CORRUPT",
    match: (_n, m, fromNifra) => nifraOwned(m, fromNifra, /^idempotency: corrupt stored response/),
    cause:
      "A stored idempotency record could not be replayed: its body or status is not in the form the middleware wrote.",
    fix: "First confirm whether the original operation completed: deleting the record lets the next retry with that key run the handler again, which repeats any side effect already done (a charge, an email). Delete the record only once the operation is known not to have completed, or reconcile its effect by hand. If it recurs, check that nothing else writes to the idempotency store and that the store does not alter values.",
    docsAnchor: "errors#idempotency-store-corrupt",
  },
  {
    code: "NIFRA_AUTHJS_REQUEST_FAILED",
    match: (_n, m) => /^\[nifra\/authjs\] /.test(m),
    cause:
      "The Auth.js bridge called an Auth.js endpoint (sign in, sign out, CSRF token) and it failed or did not answer.",
    fix: "The message gives the HTTP status. Check that the Auth.js endpoint is mounted and answering.",
    docsAnchor: "errors#authjs-request-failed",
  },
  {
    code: "NIFRA_ACTION_FAILED",
    match: (_n, m, fromNifra) =>
      nifraOwned(m, fromNifra, /^\[nifra\/web\] (?:fetcher )?action failed \(/),
    cause:
      "A route action request answered with a non-OK status, so the router threw instead of returning a result.",
    fix: "The message gives the status and the action URL. Look at the response and logs for that status on the server.",
    docsAnchor: "errors#action-failed",
  },
  {
    code: "NIFRA_STRICT_MODE",
    match: (_n, m) => m.includes("Strict mode is on, so this process refuses to start"),
    cause:
      "A startup check failed while strict mode is on, so the process refuses to start instead of running with the problem.",
    fix: "Fix the problems the message lists above that line. Strict mode is meant to turn them into a startup failure.",
    docsAnchor: "errors#strict-mode",
  },
  {
    code: "NIFRA_LIBRARY_RESOLUTION",
    match: (_n, m, fromNifra) =>
      m.includes("two copies of React reached SSR") ||
      nifraOwned(
        m,
        fromNifra,
        /^\[nifra\/web\][^\n]*(?:is installed but failed to load|resolved but failed to load|needs .vite. installed)/,
      ),
    cause:
      "A UI library or optional peer did not resolve to one working copy: two copies of React reached server rendering (react-dom renders with a different React than your components import), or an optional peer is missing or failed to load.",
    fix: "For two copies, dedupe the library in your package manager so react-dom and your components import the same React. For a peer, the message names it and the underlying error: install it, or use the default build.",
    docsAnchor: "errors#library-resolution",
  },
  {
    code: "NIFRA_RUNTIME_MISSING",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^\[nifra\] (?:app\.ws\(\) needs the WebSocket runtime|app\.sse\(\) needs the streaming runtime|MCP declarations ship as an opt-in runtime|resolveNode\(\) needs the Node-direct renderer|a Bun server with mounted WebSocket routes needs the websocket\(\) runtime)/,
      ),
    cause:
      "A feature was used without its opt-in runtime installed: WebSocket routes, server-sent events, MCP declarations or the Node-direct renderer ship as separate plugins so apps that do not use them stay small.",
    fix: "The message names the plugin. Add the `.use(...)` it shows (websocket() from @nifrajs/core/ws, the streaming runtime, mcp(), or nodeDirect() from @nifrajs/core/node-direct) before declaring the routes that need it, on the parent app when the routes are mounted from a child.",
    docsAnchor: "errors#runtime-missing",
  },
  {
    code: "NIFRA_SERVER_LIFECYCLE",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^\[nifra\] (?:[\w\u2026]+\(\)[^\n]*? was added after createWebApp declared the page routes|server configuration is sealed after listen\(\)|listen\(\) uses Bun\.serve and runs only on Bun)/,
      ),
    cause:
      "The server was configured at the wrong time or on the wrong runtime: a hook added after the page routes were declared (no page runs it), configuration changed after listen() sealed the server, or listen() called outside Bun.",
    fix: "Move the call before listen(). For a late hook, apply it in createWebApp({ use }) to cover the pages, or inside app.group(prefix, ...). Off Bun, serve with @nifrajs/node or @nifrajs/deno, or hand app.fetch to a fetch-compatible runtime.",
    docsAnchor: "errors#server-lifecycle",
  },
]
