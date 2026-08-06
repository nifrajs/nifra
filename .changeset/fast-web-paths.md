---
"@nifrajs/core": minor
"@nifrajs/web": patch
---

Improve hot paths across runtimes and the browser: a validated-POST fused lane for Bun/Deno Web
requests (measured +12.7% Deno, +3.5% Bun on `POST /users`) plus a registration-compiled body
validation/handler continuation shared by Web and Node-direct (about 9.6% faster than the generic
body lane in-process), client route matching indexed on the core router instead of a linear scan
(measured ~18x faster on a 100-route app), search-param parsing in one pass instead of O(keys²), and
allocation-free fast paths for static asset URLs and safe SSR script serialization.
Bare fused-lane Web requests with no active timeout or deadline now run on the lazy request
context (the one the Node direct path already uses), with the platform - `c.env`, `c.clientIp`,
`c.waitUntil` - carried through and `c.signal`/`c.budget`/`c.query` resolving lazily to identical
values, pinned by a regression test. Measured +4.5% on a bare `GET /users/:id` on Deno. Routing
also stops allocating a `{ pathname, search }` pair per request on the portable path.
Node serving now keeps synchronous Web request middleware on the direct renderer, adapts in-place Web
response middleware back to direct buffered writes, and avoids redundant params/body lifecycle stages
for common validated reads. Header-only built-ins (`cache-control`, `powered-by`, and related response
mutators) no longer clone buffered responses on Node.
New portable middleware hook: `onResponseBody(body, headers, req, status)` - the post-serialization
payload tier. The hook receives the FINAL framework-serialized bytes plus the mutable header view,
and may return replacement bytes. On the Node direct writer the bytes come straight off the outcome
record; on the Web serving paths they ride the framework-built Response as an inert tag (attached
only once a body hook is registered), so no body stream is ever drained on any runtime. A
handler-returned raw `Response` (a proxied fetch, SSE, a streamed page) is skipped by contract, a
structured return (`{ body, status }`) can drop the body or change the status (an ETag `304`), and
transforming those remains `onResponse`'s job. A body-observing middleware written this way
measures at ~92% of a raw `node:http` server on the realistic route, vs ~50% through the full
`onResponse` contract.
New middleware hook: `onResponseRaw(response, req)` - the raw-response tier. It runs ONLY for
responses the payload tier skips (streams, proxied fetches, and framework-generated error
responses); a framework-serialized JSON body stays on `onResponseBody` and, on Node, on the direct
socket writer (the raw hook self-pairs with a no-op native twin, so registering one does not force
the fallback path). Together the two tiers cover every response without double-processing any.
Response-body tagging is now scoped per app instance instead of process-wide: one app registering a
body hook no longer makes unrelated apps in the same process pay for tagging, `merge()` keeps the
tag readable across merged apps, and a foreign Response carrying a look-alike marker is not treated
as a framework-serialized body.
Bodiless statuses are normalized on every render path: a handler returning a `204`/`205`/`304` (or
a body hook converting to one, e.g. an ETag `304`) always ships with no body and no
`content-length`, on the Web paths and the Node direct writer alike.
Response-header records are built null-prototyped everywhere user-influenced names can land in
them, so header names like `__proto__` stay data instead of touching the record's prototype; the
header view over Node outcomes also resolves names via a one-time per-request index instead of
scanning the record on every get/set (measured at roughly a fifth of the framework's own CPU on a
realistic middleware-carrying route).
Guarded response headers (a raw `fetch()`ed Response) are now detected with a reversible probe
before any header hook runs, instead of catching the mutation `TypeError` and re-running the hook
against a clone - a hook that itself throws `TypeError` no longer runs twice. Framework-constructed
responses stamp their headers as known-mutable at construction, so the hot path answers that
question with a single weak-set lookup and only a handler-returned foreign `Response` ever pays the
probe, once per headers object.
New portable middleware hook: `onResponseHeaders(headers, req, status)` - the recommended shape for
response middleware that only reads or writes headers. One implementation runs on every runtime: on
the Web serving paths it mutates the response's own `Headers` inside the normal response walk (no
clone), and on Node it self-pairs as a native hook against the outcome record, so registering one
never forces the Node adapter off its direct socket writer the way a full `onResponse(res:
Response)` hook does.
Native Node hook lanes now engage as a unit - the response-side native hooks run only when the
request side is native too - which makes the native request context's identity stable across a
request; the context also carries `url`, and both are documented so middleware twins can key
per-request state on it. Building a Web `Request` from a Node request fills its header list once
from a plain record instead of copying a prebuilt `Headers` a second time.
Query and cookie parsing intern repeated key names on V8-based runtimes (Node, Deno) through a small
bounded cache - V8 pays ~13x to store a freshly-sliced string key on the null-prototype records the
parsers build, so handing back the first-seen key makes the store take the fast path. High-cardinality
or oversized keys bypass the cache and behave exactly as before, and JSC (Bun) skips the scheme
entirely (it has no such cost).
When any route registers `onResponseBody`, every JSON response with caller-set headers (the common
shape once a route has middleware) stopped pre-building a throwaway `Headers` instance just to
check for an existing `content-type` - that instance was immediately handed to `new Response()`,
which does its own header ingestion regardless, so the pre-build was pure waste. The check now runs
against whatever shape the headers already are (a plain record gets a shallow copy only when
`content-type` is absent; an already-built `Headers` is mutated in place, as before) and that result
goes straight into the `Response` constructor. Deno/V8 charged far more for the discarded `Headers`
instance than Bun/JSC did - measured previously as the entire gap between the payload tier's Deno
row and its own raw ceiling on the realistic-shape benchmark; that row now leads every peer
framework and sits within a few percent of raw `Deno.serve` again.
On Deno, JSON responses that carry caller-set headers are now built as a bare `Response` whose
headers are set individually afterwards, instead of handing the header record to the constructor -
Deno charges far more to ingest a header-record init than to mutate a built response's `Headers`.
The runtime's own `Response.json` content-type is probed once and reused, so the wire contract is
exactly what `Response.json` ships on that runtime, and Bun keeps the constructor path it measures
faster on. Measured +7% on the realistic middleware GET row and +12.7% on its body-hash variant;
with this, the realistic Deno rows lead the closest peer framework on both GET and POST.
The native header view's one-time name index is now authoritative for every operation, including
writes of names not yet present: setting a new header no longer walks and lowercases the whole
record on the way in, which had made each fresh `set()` cost grow with the headers already written
(measured +2.2% end to end on the realistic middleware-carrying Node GET row). Case-insensitive
reads still cover the record as first seen plus everything written through the view; a native twin
writing the record directly uses lowercase names - the wire form the record documents.
New response tier: `app.responseHeaders(record)` (and `responseHeaders` on a middleware bundle) for
response headers with no per-request decision behind them. Declaring them registers no response hook,
so the values fold into response construction - one prebuilt init for JSON renders, one record merge
where the request set its own headers - and an app whose response middleware is only static keeps the
lanes a hook closes: Bun's fused native routes, and the Node direct socket writer that a full
`onResponse` gives up. They still apply to every response a hook would cover (success, error,
404/405, timeout, short-circuit), byte-identically to registering the same names as an
`onResponseHeaders` hook, on every runtime - pinned by parity suites over `app.fetch`, the Node
adapter's own socket writes, and the Deno serve path. Declared headers are DEFAULTS: a value the
request produced (`c.set.headers`, or a response hook) wins, whatever casing it used, and one name
spelled two ways still ships as one header line. Names are lowercased once at wire-up; a non-string
value, an invalid name, `__proto__`, or a name the render owns (`content-type`, `content-length`,
`transfer-encoding`, `set-cookie`) throws a `TypeError` there instead of surfacing on the wire.
Declarations made before any response hook merge into one record; one made after a hook registers as
an ordinary header hook so registration order is preserved.
`securityHeaders()` and `poweredBy()` (in its default respect-existing configuration) now declare
their headers instead of writing them from a hook: measured +11% on a bare Bun `GET` behind
`securityHeaders()`, within noise on Node and Deno (where the per-response header writes, not the
response walk, dominate). Middleware whose headers depend on the request keeps the hook - `cors`
reflects an origin, and `cacheControl` gates on method and status.
