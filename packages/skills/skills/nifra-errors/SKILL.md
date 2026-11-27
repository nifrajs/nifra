---
name: nifra-errors
description: Use when a Nifra error, dev-overlay diagnostic or `nifra check` finding carries a stable code (NIFRA_BACKEND_IN_CLIENT, NIFRA_SCHEMA_PARSE, NF-C031, ...) - maps each code to its cause and repair. Also covers Solid 2.0 reactivity diagnostics the dev feed records. Load after the `nifra` skill.
metadata:
  docs: https://nifra.dev/docs/errors
---

# Nifra: repairing from an error code

Generated from the catalogs `nifra explain` answers from; do not edit by hand (`bun run gen:errors`).
Find the code in the error or finding, jump to its heading (the lower-cased code), apply the fix, then
run the verify step. A code is stable forever: it is never renumbered or reused.

`nifra explain <code-or-message>` returns the same entry live, with the frame in your source.

## Runtime and build errors

### NIFRA_BACKEND_ONLY_IN_CLIENT

**Cause:** A module that imports the `@nifrajs/web/backend-only` marker was reachable from a client entry, so it would ship to the browser.

**Fix:** Follow the import chain in the message and move the module under backend/, reached from the route's x.backend.ts (loader/action) or a *.fn.ts server function.

Ways to fix it:
- Load it on the server: Move the module under backend/ and call it from the route's x.backend.ts loader or action; the page receives the result through loaderOutput/actionOutput.
- Make it a server function: Move the call into a backend/*.fn.ts server function and import that from the page; the browser bundle gets a stub that calls the server.

Docs: https://nifra.dev/docs/errors#backend-only-in-client

### NIFRA_BACKEND_IN_CLIENT

**Cause:** Browser code imported a module the zones keep on the server: backend/, a route's x.backend.ts, a server package, or a module outside every zone.

**Fix:** Reach backend code through the route's x.backend.ts (loader/action) or a *.fn.ts server function; put code both sides need in shared/. The message names the import chain.

Ways to fix it:
- Load it on the server: Call the backend code from the route's x.backend.ts loader or action and pass the result to the page through loaderOutput/actionOutput.
- Make it a server function: Wrap the call in a backend/*.fn.ts server function and import that from the page; the browser bundle gets a stub that calls the server.
- Share pure code: If the imported code needs nothing from the server (no secrets, database or Node APIs), move it to shared/ so both sides may import it.

Docs: https://nifra.dev/docs/errors#backend-in-client

### NIFRA_NODE_BUILTIN_IN_CLIENT

**Cause:** A `node:` built-in was reached from a client entry; it has no browser implementation.

**Fix:** Move the code using the built-in under backend/ or into the route's x.backend.ts; the message lists the import chain that pulled it in.

Docs: https://nifra.dev/docs/errors#node-builtin-in-client

### NIFRA_OUTPUT_SENSITIVE_FIELD

**Cause:** An output schema declares a field whose name marks it as a credential (password, token, secret, ...), so the route refuses to send it to the browser.

**Fix:** Remove the field from loaderOutput/actionOutput. If it truly must reach the browser, wrap it in t.declassified(reason, schema). `nifra check` reports the same as NF-C031.

Ways to fix it:
- Drop the field: Remove the field from loaderOutput/actionOutput so the guard projects it away; the page must not need it.
- Declassify it: Only if the browser genuinely needs the value: wrap the field's schema in t.declassified(reason, schema) with a reason a reviewer can check.

Docs: https://nifra.dev/docs/errors#output-sensitive-field

### NIFRA_OUTPUT_UNDECLARED_DEFERRED

**Cause:** The loader returns a deferred (streamed) value its output schema does not declare.

**Fix:** Declare the field with t.deferred(schema) in loaderOutput, or stop deferring it.

Ways to fix it:
- Declare it as deferred: Declare the field with t.deferred(schema) in loaderOutput so the streamed value is projected like the rest.
- Stop deferring it: Await the value in the loader and return it directly; its existing schema then covers it.

Docs: https://nifra.dev/docs/errors#output-undeclared-deferred

### NIFRA_OUTPUT_RAW_RESPONSE

**Cause:** A loader or action returned a successful Response; its body would reach the browser without passing the output schema.

**Fix:** Return the data itself so the schema projects it, or serve the raw response from a backend/app.ts route.

Ways to fix it:
- Return the data: Return the data itself from the loader or action so its output schema projects it.
- Serve it from a backend route: Move the raw response to a route in backend/app.ts and have the page link to or fetch it there.

Docs: https://nifra.dev/docs/errors#output-raw-response

### NIFRA_OUTPUT_SCHEMA_MISMATCH

**Cause:** Data a loader or action returned does not match its declared output schema, so it was refused before rendering.

**Fix:** Make the returned value match loaderOutput/actionOutput at the listed paths, or update the schema if the shape changed on purpose.

Ways to fix it:
- Fix the data: Change what the loader or action returns so it matches loaderOutput/actionOutput at the listed paths.
- Update the schema: If the shape changed on purpose, update loaderOutput/actionOutput to describe exactly the fields the page needs.

Docs: https://nifra.dev/docs/errors#output-schema-mismatch

### NIFRA_OUTPUT_GUARD

**Cause:** Route data failed the output guard that stands between loaders/actions and the browser.

**Fix:** Declare loaderOutput/actionOutput as a Standard Schema that describes exactly the fields the page needs; `nifra check` flags routes without one (NF-C030).

Docs: https://nifra.dev/docs/errors#output-guard

### NIFRA_HYDRATION_MISMATCH

**Cause:** The browser rendered different markup than the server sent, so the framework discarded or patched the server HTML.

**Fix:** Look for values that differ between server and browser during render (Date.now(), Math.random(), locale formatting, window/localStorage reads, invalid HTML nesting). With happy-dom installed in the project, nifra_hydrate reproduces it with a stable diagnostic.

Docs: https://nifra.dev/docs/errors#hydration-mismatch

### NIFRA_CDN_HOST_ROUTED

**Cause:** cloudflareWorkersCache was told the Worker serves different content per hostname. Workers Cache keys pages by path, not host, so it would serve one host's page to another.

**Fix:** Put a Cloudflare zone in front instead (cloudflareZone), or serve each hostname from its own Worker.

Docs: https://nifra.dev/docs/errors#cdn-host-routed

### NIFRA_CDN_TAG_INVALID

**Cause:** A route's revalidateTags function returned a tag that is not a letter followed by up to 127 of A-Z a-z 0-9 . _ : / -, more than 32 tags, or something other than an array. Those tags were dropped, so a purge by them reaches nothing.

**Fix:** Build tags from route params only (`"product:" + params.id`), keep to the allowed characters, and return at most 32.

Docs: https://nifra.dev/docs/errors#cdn-tag-invalid

### NIFRA_CDN_RATE_LIMITED

**Cause:** The CDN's purge API refused a purge with 429. Cloudflare's Free plan allows 5 purge calls a minute, and Workers Cache always has Free-plan limits.

**Fix:** Nothing, if the line says retrying: the queue waits out Retry-After. If purges keep hitting the limit, batch them (one revalidate call with several tags) or raise debounceMs.

Docs: https://nifra.dev/docs/errors#cdn-rate-limited

### NIFRA_CDN_PURGE_FAILED

**Cause:** The CDN's purge API refused a purge, or could not be reached. The origin store was purged; the CDN may keep serving the old page until its freshness runs out.

**Fix:** Read the reason in the line: a 401 or 403 means the token lacks purge permission for this zone, project or service; a 5xx or network_error is retried on its own.

Docs: https://nifra.dev/docs/errors#cdn-purge-failed

### NIFRA_KEEPALIVE_IDENTITY_COOKIE

**Cause:** The app keeps pages alive, and a response changed an HttpOnly cookie nifra does not know as a sign-in cookie. If that cookie says who is signed in, a sign-in or sign-out through it leaves the previous visitor's kept pages in every tab, and back shows them.

**Fix:** Name the cookie in createWebApp({ keepAlive: { identityCookies } }) if it carries the session, or in keepAlive.ignoreCookies if it does not.

Ways to fix it:
- It is the session cookie: Add it to createWebApp({ keepAlive: { identityCookies: ["<name>"] } }): a response that changes or deletes it rotates the identity epoch, and every tab drops its kept pages.
- It says nothing about the visitor: Add it to createWebApp({ keepAlive: { ignoreCookies: ["<name>"] } }) so development stops reporting it.
- Identity lives in a token: When the session is a bearer token in client storage, call identityChanged() from @nifrajs/web/client at sign-in and sign-out; it drops kept pages in every tab.

Docs: https://nifra.dev/docs/errors#keepalive-identity-cookie

### NIFRA_KEEPALIVE_DIRECT_CHILD_CSS

**Cause:** A keepAlive page renders inside two display:contents wrappers, so a selector that reached its top-level element as a direct child (or by its position among siblings) no longer matches it.

**Fix:** Rewrite the selector the message names: a descendant combinator, the wrapper as the parent, or a class on the page's root element.

Ways to fix it:
- Use a descendant combinator: Write `main section` instead of `main > section`: the wrappers sit between the two.
- Target the wrapper: Write `[data-nifra-page] > section`: the inner wrapper is the page's parent while it is shown.
- Put a class on the page root: Give the page's root element a class and select it directly, instead of by its parent or its position.

Docs: https://nifra.dev/docs/errors#keepalive-direct-child-css

### NIFRA_SOLID_DIAGNOSTIC

**Cause:** Solid 2.0's dev build reported a reactivity mistake: the message opens with Solid's own stable code, then names the owner path, the source location, and the guide for that code.

**Fix:** Read the code in square brackets, open the repair guide the message names (node_modules/solid-js/skills/reactivity-diagnostics/SKILL.md, anchored by the lower-cased code) and apply its repair at the `at` location. Do not silence the report: Solid raises each one for a real defect or a real cost.

Docs: https://nifra.dev/docs/errors#solid-diagnostic

### NIFRA_COMPONENT_REQUEST

**Cause:** A server component request failed. The error carries a `code` (component_input, component_denied, component_version, component_busy, component_timeout, component_cancelled, component_failed, ...) and no further detail.

**Fix:** Read the `code` property on the error, then look for the cause on the server: its logs hold the detail the browser was not given.

Ways to fix it:
- component_input (422): The props or input the page sent failed the component's input schema. Compare what the page passes with the schema in its defineServerComponent call.
- component_denied (401, 403 or 404): Either the request was not same-origin (Sec-Fetch-Site was not same-origin, or Origin named another site: call the component from your own pages), or the component's authorize callback refused it (it threw a 401, 403 or 404): check that callback and the caller's credentials.
- component_version (409): The browser's build differs from the server's, usually because a deploy landed while the page was open. Reload the page.
- component_busy (429): The server's component queue is full: every render slot is busy and the waiting queue is at capacity. Reduce how many components render at once, or the work each one does.
- component_timeout or component_cancelled: A component outran its deadline (timeout), or the request was aborted first, for example by the visitor navigating away (cancelled). For a timeout, speed up the data the component waits on.

Docs: https://nifra.dev/docs/errors#component-request

### NIFRA_COMPONENT_BUILD

**Cause:** The server component build refused the project: a component module, a build entry, or the source graph breaks a rule the compiler relies on.

**Fix:** The message names the rule and, where it can, the file. Fix that one thing and rebuild; the build never ships a bundle it refused.

Docs: https://nifra.dev/docs/errors#component-build

### NIFRA_PPR_CONTRACT

**Cause:** A partially prerendered route broke the contract that lets its shell be shared between visitors: a visitor-specific loader, a dynamic hole set up wrongly, a nonce in the shell, or an invalid `ppr` option.

**Fix:** The message names the route and the rule. Keep per-visitor data out of the shell (move it into a dynamic boundary, or mark a layout loader `gate`), give every hole a boundaryLoaders entry, and use `csp: createCspPolicy(...)` instead of a per-request nonce.

Docs: https://nifra.dev/docs/errors#ppr-contract

### NIFRA_DEPLOYMENT_OUTPUT

**Cause:** A deployment adapter or the build output it was given broke a deployment rule: an unsafe or oversized output tree, a path collision, or an adapter that does not implement the interface this Nifra build supports.

**Fix:** The message names the adapter, the path or the limit. Emit additions only through the returned files array, keep paths relative and case-distinct, and match the adapter API version this Nifra build supports.

Docs: https://nifra.dev/docs/errors#deployment-output

### NIFRA_LIVE_CONFIG

**Cause:** The live (real-time) option set is invalid: a missing or short secret, a hub and bus configured together, a path that is not absolute, or a subject that does not return a string.

**Fix:** The message names the option. A secret must be at least 32 bytes (`openssl rand -base64 32`), and `hub` and `bus` are exclusive.

Docs: https://nifra.dev/docs/errors#live-config

### NIFRA_ROUTE_SLOT_UNAVAILABLE

**Cause:** A route slot named a parent route, a slot name, or a target route that is not registered, so the slot cannot render.

**Fix:** Register the route the slot points at, and spell the slot name as the parent route declares it.

Docs: https://nifra.dev/docs/errors#route-slot-unavailable

### NIFRA_CLIENT_BUILD_NO_GRAPH

**Cause:** The client build's result had no metafile (or one without inputs or outputs), so Nifra cannot prove which modules reached the browser. It refuses to write the bundle rather than guess.

**Fix:** Build the client through nifra's build, which keeps the bundler's metafile. A custom build step must request the metafile and pass it through.

Docs: https://nifra.dev/docs/errors#client-build-no-graph

### NIFRA_VUE_WARNING

**Cause:** Vue's development build warned about a component. The text after `[Vue warn]:` names the problem, and Vue's component trace names the component it happened in.

**Fix:** Fix the component the trace names. Do not silence Vue's warn handler: each warning is raised for a real mistake in that component.

Docs: https://nifra.dev/docs/errors#vue-warning

### NIFRA_SVELTE_DIAGNOSTIC

**Cause:** Svelte's development build reported a mistake. The identifier after `[svelte]` (or at the end of the https://svelte.dev/e/ link) is Svelte's own stable code.

**Fix:** Open https://svelte.dev/e/<code> for the cause and the repair, then fix the component the message locates.

Docs: https://nifra.dev/docs/errors#svelte-diagnostic

### NIFRA_REACT_WARNING

**Cause:** React reported a mistake: a development warning that links to react.dev/link/..., or an error whose message links to react.dev/errors/... (a minified production error).

**Fix:** Open the link in the message for the cause and the repair, then fix the component React's trace names. A react.dev/errors message is a thrown error, not a warning.

Docs: https://nifra.dev/docs/errors#react-warning

### NIFRA_PREACT_DIAGNOSTIC

**Cause:** Preact's debug build reported a mistake in a component: invalid nesting, a duplicate key, an invalid element type, a hook outside render, a render loop, or a prop of the wrong type. Preact has no stable code, so the message text is the identifier.

**Fix:** Fix the component the message names; Preact appends its component stack. Do not remove preact/debug to quiet it: each message is raised for a real mistake.

Docs: https://nifra.dev/docs/errors#preact-diagnostic

### NIFRA_MEMORY_STORE_IN_PRODUCTION

**Cause:** An in-memory store (rate-limit MemoryStore, MemoryIdempotencyStore, MemoryResponseCache, MemorySessionStore) was created in production. Each instance keeps its own copy, so limits, de-duplication, cached responses or sessions differ per instance and are lost on restart.

**Fix:** Pass a shared store (for example Redis-backed), or pass { allowInProduction: true } when the app runs as a single instance.

Ways to fix it:
- Use a shared store: Give the middleware or session manager a store every instance reads and writes (Redis or another shared backend) instead of the Memory* default.
- Single instance only: Pass { allowInProduction: true } when exactly one instance serves traffic and losing state on restart is acceptable.

Docs: https://nifra.dev/docs/errors#memory-store-in-production

### NIFRA_CORS_CREDENTIALS_WILDCARD

**Cause:** cors() was given `credentials: true` with `origin: "*"`. Browsers refuse a wildcard origin on a credentialed request, so the combination can never work.

**Fix:** List the explicit origin(s) that may send credentials instead of the wildcard.

Docs: https://nifra.dev/docs/errors#cors-credentials-wildcard

### NIFRA_SECRET_TOO_SHORT

**Cause:** A signing secret is shorter than the 32 bytes (256 bits) nifra requires, so it is refused instead of used.

**Fix:** Generate one with `openssl rand -base64 32` and load it from the environment.

Docs: https://nifra.dev/docs/errors#secret-too-short

### NIFRA_MIDDLEWARE_ORDER

**Cause:** A middleware that protects routes was installed after the routes it should guard, so those routes were registered without it.

**Fix:** Call app.use(...) for it before registering the routes it protects.

Docs: https://nifra.dev/docs/errors#middleware-order

### NIFRA_CONTEXT_STORAGE_MISSING

**Cause:** getContext() ran outside a request that went through contextStorage(): the middleware was not installed before the route, or the code ran outside any request (a partially prerendered shell is built outside every request).

**Fix:** Add app.use(contextStorage()) before the route and call getContext() during that request. For a PPR shell, read the request in a dynamic boundary's loader instead.

Docs: https://nifra.dev/docs/errors#context-storage-missing

### NIFRA_SESSION_STORE_CONSISTENCY

**Cause:** The session manager was given an eventually consistent store such as KVSessionStore. Logout and rotation need a read to see the write that revoked a session, which that kind of store does not promise.

**Fix:** Use a strongly consistent shared SessionStore.

Docs: https://nifra.dev/docs/errors#session-store-consistency

### NIFRA_ROUTE_CONFIG

**Cause:** A route is misconfigured, and registration refuses it at boot rather than failing on the first request. The error's `code` names the rule (DUPLICATE_ROUTE, INVALID_PATH, INVALID_METHOD, WILDCARD_NOT_LAST, INVALID_IDEMPOTENCY, ...).

**Fix:** Read the `code` and the message, then correct the route definition they name. The server does not start until the route is valid.

Docs: https://nifra.dev/docs/errors#route-config

### NIFRA_WIRE_INVALID

**Cause:** A value could not be encoded or decoded on the typed wire: a malformed frame, an unsupported codec or content type, a payload over maxBytes, or a value that is not JSON serializable.

**Fix:** Send values the wire can carry, from a client built against this server's contract. For an oversized payload, send less or raise maxBytes on purpose.

Docs: https://nifra.dev/docs/errors#wire-invalid

### NIFRA_STORAGE_KEY

**Cause:** A storage key was refused before any read or write: it is empty or over 1024 characters, is absolute, has a backslash, NUL, ".." or an empty or "." segment, escapes the storage root, or reaches the file through a symbolic link, a moved root directory or an untrusted writable directory.

**Fix:** Build keys as relative, forward-slash paths that stay under the storage root, and never put unchecked user input into a key. For a symbolic link, a moved root or an untrusted directory, the message names what to check on the filesystem.

Docs: https://nifra.dev/docs/errors#storage-key

### NIFRA_STORAGE_READ_LIMIT

**Cause:** An R2 object is larger than maxReadBytes (or reports invalid size metadata), so R2Storage refuses to buffer it. The key itself was valid.

**Fix:** Raise maxReadBytes on the R2Storage if objects of that size are expected; otherwise find why the object is larger than the limit.

Docs: https://nifra.dev/docs/errors#storage-read-limit

### NIFRA_OPENAPI_IMPORT

**Cause:** The OpenAPI document cannot be imported: it is malformed, uses a version outside 3.0.x, 3.1.x and 3.2.x, exceeds an import limit, or holds a construct Nifra cannot represent (a parameter $ref, an unsupported path template).

**Fix:** The message names the path in the document. Fix that part, and inline parameter $refs before importing: refs are never resolved.

Docs: https://nifra.dev/docs/errors#openapi-import

### NIFRA_ASSURANCE_INPUT

**Cause:** An assurance, capability, manifest or evidence declaration is malformed: an id, path glob, scope, provenance, method or policy field outside what the registry accepts.

**Fix:** The message names the field and the accepted form (lowercase dot/dash ids, absolute path globs, a known scope). Correct the declaration; `nifra check` reports the same project-wide.

Docs: https://nifra.dev/docs/errors#assurance-input

### NIFRA_EFFECT_INVALID

**Cause:** An effect, saga or durable-journal declaration, or the store behind it, broke its contract: a value out of range, a missing step, or a store that is not durable where durability is required.

**Fix:** The message names the part. Where it says `store.durability === "durable"`, back the journal with a durable store; otherwise correct the id, cost or limit it names.

Docs: https://nifra.dev/docs/errors#effect-invalid

### NIFRA_CONTENT_INVALID

**Cause:** A content collection, its baked index, or an MDX extension is malformed or out of range.

**Fix:** The message names the index, bucket or extension. Correct the collection definition it names.

Docs: https://nifra.dev/docs/errors#content-invalid

### NIFRA_BUILD_PLUGIN

**Cause:** A build plugin (CSS Modules, SCSS, StyleX, a Vue single-file component, Svelte MDX) failed on a file or is missing a compiler dependency.

**Fix:** The message names the file and the compiler's own reason. Fix that source, or install the compiler package it says is missing or incompatible.

Docs: https://nifra.dev/docs/errors#build-plugin

### NIFRA_BUILD_OUTPUT

**Cause:** The client or server build, or the directory it writes to, broke a rule: no entry-point output, an output or public directory that is a symlink, escapes its root or overlaps the other, a build target the chosen option does not fit, or a glob pattern the bundler cannot read.

**Fix:** The message names the path, target or option. Move the output or public directory, drop the option the target does not support, or give the bundler a literal pattern.

Docs: https://nifra.dev/docs/errors#build-output

### NIFRA_ROUTE_FILES

**Cause:** The file routes, or a route's exports, break a convention the router relies on: two files map to one URL, two `_404` files answer the same URLs, an optional segment is mixed with literal text, a layout exports an `action`, or a route turns off both server rendering and hydration.

**Fix:** The message names the files and the rule. Keep one file per URL, one `_404` per scope, and put actions in route files, not layouts.

Docs: https://nifra.dev/docs/errors#route-files

### NIFRA_I18N_CONFIG

**Cause:** The locale, copy-table or localized-path configuration breaks a rule: a duplicate id or canonical pathname, two locales sharing an hreflang, a draft default locale, or a copy value of the wrong kind.

**Fix:** The message names the locale, table or pathname. Make the ids and pathnames unique and give each locale its own hreflang.

Docs: https://nifra.dev/docs/errors#i18n-config

### NIFRA_JOBS_INVALID

**Cause:** A job, its payload, or a dead-letter record cannot be stored as data: a duplicate job name, an Error instance, a custom prototype, an accessor, or a record the dead-letter view cannot read.

**Fix:** Make the payload plain data (objects, arrays, strings, numbers, booleans), and give each job one name.

Docs: https://nifra.dev/docs/errors#jobs-invalid

### NIFRA_SCHEMA_DECLARATION

**Cause:** A schema declaration uses something the schema builder cannot accept: a file list nested in a list, a file field outside t.form(), a header name that is not lower-cased, a declassified field with no reason, or a feature precompile refuses (custom registry kinds, runtime-only metadata).

**Fix:** The message names the declaration and what it expects. Declare file fields in t.form(), give declassified a reason, and keep precompiled schemas to plain, compilable shapes.

Docs: https://nifra.dev/docs/errors#schema-declaration

### NIFRA_ASSET_INVALID

**Cause:** A font, web manifest or service-worker asset was refused: a download from a non-allowed host or over its size limit, a stylesheet with no usable font files, an unknown manifest value, or a path with characters an asset path cannot hold.

**Fix:** The message names the family, URL or field. Request only Google-hosted fonts within the limits, and use the manifest values and path characters it lists.

Docs: https://nifra.dev/docs/errors#asset-invalid

### NIFRA_HEADER_VALUE_INVALID

**Cause:** A response header or cookie value was refused: a control character, a newline, a leading or trailing space, an illegal character in a cookie Domain or Path, a `__Host-` cookie with a Domain, a cookie over its size limit, or a framing header set statically.

**Fix:** The message names the header or cookie. Remove the character it names, and set per-response headers with c.set.headers (cookies with c.set.cookie) instead of statically.

Docs: https://nifra.dev/docs/errors#header-value-invalid

### NIFRA_CSP_CONFIG

**Cause:** The Content-Security-Policy or inline-script setup conflicts: a cspHeader and a nonce resolver both writing the header, an executable inline script without a nonce, content the inert head.script slot refuses, or a policy used before it was prepared.

**Fix:** The message names the conflict. Use either `nonce` or `csp: createCspPolicy(...)`, give executable scripts a non-empty nonce, and use unsafeInlineScript() only where the message says to.

Docs: https://nifra.dev/docs/errors#csp-config

### NIFRA_CDN_CONFIG

**Cause:** A CDN adapter was given a missing binding or a store that cannot do what was asked (for example invalidate by tag), or an option outside what it accepts.

**Fix:** The message names the adapter and what to pass (the `cache` binding, the @vercel/functions helper, a store that supports tags). Pass it where the CDN is configured.

Docs: https://nifra.dev/docs/errors#cdn-config

### NIFRA_PARITY_FAILED

**Cause:** The development/production parity check failed (identity parity or manifest parity), or its scan hit the limit before it could decide.

**Fix:** Read the differences the message lists and make development and production agree. When the scan limit was reached, narrow the scan by running from the app or workspace root.

Docs: https://nifra.dev/docs/errors#parity-failed

### NIFRA_API_MISUSE

**Cause:** An API was called in a state it does not allow: next() called twice, a request body read as a stream after it was consumed, a response body sent twice, headers written after the response was committed, notFound() applied twice or inside a group, or a query used with no query client.

**Fix:** The message names the call. Call it once, before the response is committed, and on the object it belongs to (read bodies with c.req.bytes() in a hook; apply notFound() to the parent server).

Docs: https://nifra.dev/docs/errors#api-misuse

### NIFRA_WEBSOCKET_INVALID

**Cause:** A WebSocket was opened or closed in a way the protocol or the client does not allow: a close reason over 123 UTF-8 bytes, a close code a server may not send, a path with a dot segment, or an in-process client that has no socket.

**Fix:** Close with a reason of at most 123 bytes and a code in 1000-1003, 1007-1014 or 3000-4999. Open sockets against a listening app, at a path without `.` or `..` segments.

Docs: https://nifra.dev/docs/errors#websocket-invalid

### NIFRA_VALUE_NOT_SERIALIZABLE

**Cause:** A value could not be turned into JSON or the typed wire: a circular reference, a BigInt, a non-finite number, a class instance, an undefined field or array item, or a type the wire has no encoding for.

**Fix:** Send plain data: objects, arrays, strings, finite numbers and booleans. Convert BigInt and class instances to plain values before they cross the boundary.

Docs: https://nifra.dev/docs/errors#value-not-serializable

### NIFRA_CRON_INVALID

**Cause:** A cron schedule or job registration is invalid: not five space-separated fields, an empty, out-of-range or malformed term, or two jobs with the same name.

**Fix:** Write the schedule as five space-separated fields with each value in its range, and register each job name once.

Docs: https://nifra.dev/docs/errors#cron-invalid

### NIFRA_GRAPHQL_REQUEST

**Cause:** A GraphQL request was malformed (no `query`, a body that is not a JSON object, variables that are not a JSON object), or mountGraphql was configured in a way it refuses.

**Fix:** For a request, send a JSON object with a `query` string and an object for `variables`. For mountGraphql, call `.use(websocket())` before enabling subscriptions, and guard sockets with the same authorization as the HTTP endpoint.

Docs: https://nifra.dev/docs/errors#graphql-request

### NIFRA_IMAGE_INVALID

**Cause:** An image could not be processed or generated: a source that failed to decode or changed while it was being opened, variants without positive dimensions, or generated output over its size limit.

**Fix:** The message names the step. Give the image a valid source and positive dimensions, and keep generated output within maxBytes.

Docs: https://nifra.dev/docs/errors#image-invalid

### NIFRA_HTTP_RESPONSE_INVALID

**Cause:** The server adapter could not write or read the HTTP message: a status code outside the valid range, a body whose length disagrees with its Content-Length, an invalid header character, or a request that closed early.

**Fix:** Return a valid status, send a body that matches the Content-Length you set (or omit it), and keep header names and values to legal characters.

Docs: https://nifra.dev/docs/errors#http-response-invalid

### NIFRA_OPTION_RENAMED

**Cause:** An option was renamed in this version, and the old name is no longer read.

**Fix:** The message gives the new name. Rename the option where you pass it.

Docs: https://nifra.dev/docs/errors#option-renamed

### NIFRA_CLIENT_REFUSED

**Cause:** The typed client refused a response or a request: a response that breaks the route's declared contract, a server-sent event over its size limit, or a form field that is neither text nor a file.

**Fix:** For a contract violation, make the server return what its route declares (or update the declaration). For a form body, send strings and files only.

Docs: https://nifra.dev/docs/errors#client-refused

### NIFRA_TOOL_INVALID

**Cause:** A tool declaration, its adapter, or its approval or budget settings break a rule: an option of the wrong type, a limit exceeded, a missing approval, or a duplicate tool name.

**Fix:** The message names the tool and the field. Correct the declaration; `nifra check` reports the same project-wide.

Docs: https://nifra.dev/docs/errors#tool-invalid

### NIFRA_JWKS_UNAVAILABLE

**Cause:** The JWKS endpoint used to verify tokens could not be used: the fetch failed, the response could not be read or was over its size limit, the key set was invalid, or the URL is not https.

**Fix:** The message gives the status or reason. Check that the JWKS URL is reachable over https (localhost is allowed) and returns a valid key set within maxBytes.

Docs: https://nifra.dev/docs/errors#jwks-unavailable

### NIFRA_BODY_PARSER_REFUSED

**Cause:** bodyParser was given a media type nifra already handles (JSON, a form, multipart) or one a browser can send from any site without a preflight request.

**Fix:** The message names the media type and what to do instead: body schemas already read JSON and forms, multipart uses multipartBody from @nifrajs/core/multipart, and a no-preflight type must be read in the handler.

Docs: https://nifra.dev/docs/errors#body-parser-refused

### NIFRA_IDEMPOTENCY_STORE_CORRUPT

**Cause:** A stored idempotency record could not be replayed: its body or status is not in the form the middleware wrote.

**Fix:** First confirm whether the original operation completed: deleting the record lets the next retry with that key run the handler again, which repeats any side effect already done (a charge, an email). Delete the record only once the operation is known not to have completed, or reconcile its effect by hand. If it recurs, check that nothing else writes to the idempotency store and that the store does not alter values.

Docs: https://nifra.dev/docs/errors#idempotency-store-corrupt

### NIFRA_AUTHJS_REQUEST_FAILED

**Cause:** The Auth.js bridge called an Auth.js endpoint (sign in, sign out, CSRF token) and it failed or did not answer.

**Fix:** The message gives the HTTP status. Check that the Auth.js endpoint is mounted and answering.

Docs: https://nifra.dev/docs/errors#authjs-request-failed

### NIFRA_ACTION_FAILED

**Cause:** A route action request answered with a non-OK status, so the router threw instead of returning a result.

**Fix:** The message gives the status and the action URL. Look at the response and logs for that status on the server.

Docs: https://nifra.dev/docs/errors#action-failed

### NIFRA_STRICT_MODE

**Cause:** A startup check failed while strict mode is on, so the process refuses to start instead of running with the problem.

**Fix:** Fix the problems the message lists above that line. Strict mode is meant to turn them into a startup failure.

Docs: https://nifra.dev/docs/errors#strict-mode

### NIFRA_LIBRARY_RESOLUTION

**Cause:** A UI library or optional peer did not resolve to one working copy: two copies of React reached server rendering (react-dom renders with a different React than your components import), or an optional peer is missing or failed to load.

**Fix:** For two copies, dedupe the library in your package manager so react-dom and your components import the same React. For a peer, the message names it and the underlying error: install it, or use the default build.

Docs: https://nifra.dev/docs/errors#library-resolution

### NIFRA_RUNTIME_MISSING

**Cause:** A feature was used without its opt-in runtime installed: WebSocket routes, server-sent events, MCP declarations or the Node-direct renderer ship as separate plugins so apps that do not use them stay small.

**Fix:** The message names the plugin. Add the `.use(...)` it shows (websocket() from @nifrajs/core/ws, the streaming runtime, mcp(), or nodeDirect() from @nifrajs/core/node-direct) on the app that declares the routes, before those routes are declared. A child app that declares its own routes needs its own `.use(...)`; for WebSocket routes mounted from a child, install it where the message says (the parent or the child).

Docs: https://nifra.dev/docs/errors#runtime-missing

### NIFRA_SERVER_LIFECYCLE

**Cause:** The server was configured at the wrong time or on the wrong runtime: a hook added after the page routes were declared (no page runs it), configuration changed after listen() sealed the server, or listen() called outside Bun.

**Fix:** Move the call before listen(). For a late hook, apply it in createWebApp({ use }) to cover the pages, or inside app.group(prefix, ...). Off Bun, serve with @nifrajs/node or @nifrajs/deno, or hand app.fetch to a fetch-compatible runtime.

Docs: https://nifra.dev/docs/errors#server-lifecycle

### NIFRA_OPTION_INVALID

**Cause:** An option passed to a nifra function (createWebApp, a middleware, a route, the CDN, ISR, a manifest) has a value outside what it accepts.

**Fix:** The message names the option and the shape it accepts. Correct the value at the call that sets it; nothing is silently coerced.

Docs: https://nifra.dev/docs/errors#option-invalid

### NIFRA_SCHEMA_PARSE

**Cause:** Data crossing a boundary did not match its declared schema.

**Fix:** Check the value against the schema at the failing boundary (loader input, search params, or request body); parse-don't-cast means the shape must match exactly.

Docs: https://nifra.dev/docs/errors#schema-parse

## `nifra check` findings

### NF-A001

Assurance bundle check

**Why:** A route fails the assurance policy in the bundle `nifra assure` builds, or declares a response contract the runtime does not enforce.

**Fix:** Fix the route the finding names, or enforce its response contract.

Docs: https://nifra.dev/docs/verification

### NF-C001

TypeScript contract check

**Why:** The project does not typecheck, or the typecheck could not run (no tsconfig.json, no TypeScript install, or source files outside the program). Every typed contract nifra keeps between frontend and backend rests on this check.

**Fix:** Fix the reported TypeScript errors; install TypeScript with `bun add -d typescript` and add a tsconfig.json that includes every source folder when the check did not run.

Docs: https://nifra.dev/docs/types-first

### NF-C002

Typed client check

**Why:** A hand-written fetch(), EventSource or WebSocket calls the project's own API, so the compiler cannot see when the route it calls changes.

**Fix:** Call the route through client<typeof app> (`.subscribe()` for an SSE route, `.ws()` for a socket route), or mark a call no typed client covers with `// nifra-expect NF-C002: <reason>`.

Docs: https://nifra.dev/docs/types-first

### NF-C003

Untyped client check

**Why:** client("...") without a type argument types every response as unknown, so frontend and backend can drift without a compile error.

**Fix:** Write client<typeof app>("...") or client(contract, url).

Docs: https://nifra.dev/docs/types-first

### NF-C004

Server-only import check

**Why:** Browser code (a route's frontend half, frontend/ or shared/) imports server-only code, which would ship to the browser or fail the build.

**Fix:** Reach the server code from the route's backend half (x.backend.ts) or through a *.fn.ts server function.

Docs: https://nifra.dev/docs/structure

### NF-C005

Removed import check

**Why:** An import names an export that moved to another module in a nifra release, so it no longer resolves.

**Fix:** Import it from the module the finding names.

Run: `nifra fix --code NF-C005`

Docs: https://nifra.dev/docs/cli

### NF-C006

Interpolated SQL check

**Why:** SQL built by interpolating a value into the statement text turns that value into SQL, so a caller who controls it can inject statements.

**Fix:** Pass the value as a bound parameter, or use the driver's tagged template, which binds each substitution; mark reviewed SQL with `// nifra-expect NF-C006: <reason>`.

Docs: https://nifra.dev/docs/database

### NF-C007

Raw response route advisory

**Why:** A route handler returns a raw Response, so the typed client infers `data: never` and drift detection is lost for that route.

**Fix:** Return a plain object (set status, headers and cookies on c.set), use app.sse() for a stream, `bytes()` from @nifrajs/core/binary for a file or other binary body, or `raw<T>(response)` from the same module for a hand-built JSON Response; or declare `{ response: t.... }`. Mark an intended redirect with `// nifra-expect NF-C007: <reason>`.

Docs: https://nifra.dev/docs/api

### NF-C008

Undeclared dependency check

**Why:** Source imports a package package.json does not declare. It resolves today only through a hoisted or global install, and a clean install will not have it.

**Fix:** Declare it with `bun add <package>`.

Docs: https://nifra.dev/docs/troubleshooting

### NF-C009

Duplicate install check

**Why:** A package resolves to more than one physical copy of one version, so module-level state (contexts, registries, instanceof checks) splits between them. Copies at different versions are NF-C046.

**Fix:** Deduplicate the installs so each resolves to one path, or declare the package single-copy in package.json's nifra.singleCopy and preload the register module.

Docs: https://nifra.dev/docs/troubleshooting

### NF-C010

Stale workspace build check

**Why:** A workspace package's build output is missing or older than its source; Bun reads the source while Vite SSR and Node read the stale build.

**Fix:** Rebuild the package with its own build script.

Run: `nifra fix --code NF-C010`

Docs: https://nifra.dev/docs/troubleshooting

### NF-C011

Build pipeline check

**Why:** A plugin or condition is configured for a bundler phase that never sees it: Vite, Bun's client and server builds, and the server bundle each read their own settings.

**Fix:** Move the setting to the phase the finding names.

Docs: https://nifra.dev/docs/dev

### NF-C012

Server manifest drift check

**Why:** server-manifest.ts no longer matches routes/. A worker without a filesystem serves the baked route table, so the drift breaks routes at the edge without an error.

**Fix:** Regenerate it and commit it.

Run: `nifra sync-manifest`

Docs: https://nifra.dev/docs/deployment

### NF-C013

Trust manifest drift check

**Why:** nifra.manifest.json, the trust artifact reviewers sign off on, is missing, invalid or out of date with the app.

**Fix:** Regenerate it, review the change, and commit it.

Run: `nifra manifest emit`

Docs: https://nifra.dev/docs/verification

### NF-C014

Capability assurance check

**Why:** A route's declared effects or capabilities do not match what its code reaches through approved adapters.

**Fix:** Align the route's declaration with the adapters it uses; never route an effect around its owned seam.

Docs: https://nifra.dev/docs/capabilities

### NF-C015

Assurance configuration check

**Why:** The capability assurance configuration could not be loaded or evaluated, so no route was checked against it.

**Fix:** Fix the error the finding quotes in nifra.assurance.ts.

Docs: https://nifra.dev/docs/verification

### NF-C016

Check configuration check

**Why:** nifra.check.json could not be parsed, so the settings in it, such as its external-mount allowlist, were ignored.

**Fix:** Fix the JSON error the finding quotes.

Docs: https://nifra.dev/docs/cli

### NF-C017

Rule pack validation

**Why:** A rule pack failed to load or threw while scanning; the rule registry fails closed rather than report a partial result as clean.

**Fix:** Fix or remove the rule pack the error names, then re-run the check.

Docs: https://nifra.dev/docs/cli

### NF-C018

Reserved client segment check

**Why:** A route path segment collides with a key the typed client proxy reserves, so dot access on the client cannot reach that route.

**Fix:** Rename the segment, or call the parent node with the segment as the finding shows.

Run: `nifra fix --code NF-C018`

Docs: https://nifra.dev/docs/routing

### NF-C019

Duplicate route registration check

**Why:** The same method and path are registered twice in one file, and which registration serves is undefined.

**Fix:** Remove or rename one of them.

Docs: https://nifra.dev/docs/routing

### NF-C020

Island enhancer cleanup check

**Why:** An island enhancer adds an event listener but returns no cleanup, so the listener outlives the island on a client navigation.

**Fix:** Return a function that removes the listener.

Docs: https://nifra.dev/docs/islands

### NF-C022

bindList key check

**Why:** A bindList key reads the item's position (a second parameter, which bindList never passes, or an indexOf/findIndex call handed the item), so adding, removing or reordering items hands a node and its state to the wrong item.

**Fix:** Key each item by a stable id on the item.

Docs: https://nifra.dev/docs/islands

### NF-C024

Overlapping route registration check

**Why:** Two route patterns match a common path (the finding shows one), so one shadows the other for some requests.

**Fix:** Make the patterns disjoint, or mark a deliberate overlap with `// nifra-expect NF-C024: <reason>`.

Docs: https://nifra.dev/docs/api

### NF-C025

Route overlap analysis budget check

**Why:** The route-overlap analysis ran out of its safety budget before it could prove two patterns disjoint.

**Fix:** Simplify the patterns, or after reviewing them by hand mark the pair with `// nifra-expect NF-C025: <reason>`.

Docs: https://nifra.dev/docs/api

### NF-C026

Route param modifier check

**Why:** A character after a route param reads as literal text, not as a modifier; a `?` in the middle of a path makes the route unreachable.

**Fix:** Use optional params only as trailing whole segments (`/users/:id?`), and a constraint as one character class (`:id{[0-9]+}`).

Docs: https://nifra.dev/docs/api

### NF-C027

Page route under the backend mount

**Why:** A page route sits under the path the backend is mounted at. The backend answers every request there first, and its 404 is final, so the page never renders.

**Fix:** Move the page, serve the URL from backend/app.ts, or mount the backend elsewhere with apiPrefix in backend/framework.ts.

Docs: https://nifra.dev/docs/backends

### NF-C028

Zone import check

**Why:** A file imports across a zone boundary the project declares, such as browser code reaching backend code, or the zone configuration itself is invalid.

**Fix:** Import through the boundary's public entry, or move the code to the zone that may use it. A frontend module backend code needs can be declared shared where it lives (a .shared suffix, or a "nifra.zones" shared entry) when its own imports are shared-safe; the finding says whether they are.

Docs: https://nifra.dev/docs/structure

### NF-C029

Private environment read in browser code

**Why:** Browser code reads a private environment variable. Browser code may read only NODE_ENV and the variables named with the app's public prefix; anything else is a server secret.

**Fix:** Read it in a loader, an action or under backend/, or rename it with the public prefix when it is meant for the browser.

Docs: https://nifra.dev/docs/structure

### NF-C030

Route data without an output schema

**Why:** A loader or action returns data to the browser without an output schema, so nothing limits which fields leave the server.

**Fix:** Export the schema beside it; the fix drafts one from the function's return type.

Run: `nifra fix --code NF-C030`

Docs: https://nifra.dev/docs/data

### NF-C031

Sensitive field in an output schema

**Why:** An output schema declares a field whose name usually holds a credential or a personal identifier, so it would be sent to the browser.

**Fix:** Remove the field, or wrap its schema in t.declassified("why it may reach the browser", ...).

Docs: https://nifra.dev/docs/data

### NF-C032

Credential in browser code

**Why:** Code that reaches the browser carries what looks like a credential.

**Fix:** Read it from the environment on the server, and rotate it if it was ever committed.

Docs: https://nifra.dev/docs/security

### NF-C033

Generated output schema out of date

**Why:** A generated output schema no longer matches what its loader or action returns, or it could not be compared, so the output guard may drop or admit the wrong fields.

**Fix:** Regenerate the schemas and review the change.

Run: `nifra schemas --write`

Docs: https://nifra.dev/docs/data

### NF-C034

Root status page wraps the root layout itself

**Why:** A root status page imports the root layout to wrap itself, but status pages render inside their layouts, so the layout renders twice.

**Fix:** Remove the wrap, or export `inLayouts = false` from the page.

Docs: https://nifra.dev/docs/routing

### NF-C035

Backend not served over HTTP

**Why:** backend/framework.ts sets no apiPrefix, so the backend is reachable from loaders only and a browser call to /api reaches page routing; or an app module's own createWebApp call mounts the backend at another apiPrefix than `nifra dev` serves it at.

**Fix:** Export `apiPrefix = "/api"` to serve it over HTTP, or `apiPrefix = ""` to keep it loader-only. At a createWebApp call, import `apiPrefix` from backend/framework.ts, or, when another server already serves the backend there, mark the call `// nifra-expect NF-C035: <reason>`.

Run: `nifra fix --code NF-C035`

Docs: https://nifra.dev/docs/backends

### NF-C036

Route path the static scan cannot read

**Why:** A route's path is computed in a way the static scan cannot read, so the route lints do not see that route, and capability provenance finds its module only from the app `nifra.assurance.ts` loads.

**Fix:** Write the path as a string literal or a module-level const, or mark a deliberately computed path with `// nifra-expect NF-C036: <reason>`.

Docs: https://nifra.dev/docs/capabilities

### NF-C037

API-only declaration over a web app

**Why:** package.json declares `"nifra": { "kind": "api" }` over a directory with web config, which would switch off the zone checks a web app needs.

**Fix:** Remove "kind", or give the web app its own package.json.

Docs: https://nifra.dev/docs/structure

### NF-C038

Retired root layout file

**Why:** The root layout is still at its retired location. Until it moves, the contract gate does not run for the app and the commands that load it refuse it.

**Fix:** Move it to the location the finding names.

Run: `nifra migrate layout --write`

Docs: https://nifra.dev/docs/migrate-5

### NF-C039

Implemented contract operation the backend does not serve

**Why:** An app implements contract operations that backend/app.ts does not serve, so the contract lock, the typed client checks and nifra routes cannot see them; or the contract cannot be read at all.

**Fix:** Mount the implementing app in backend/app.ts, built with stub dependencies if it needs any, and keep each operation's method and path as string literals.

Docs: https://nifra.dev/docs/types-first#stub-entry

### NF-C040

Layout meta reads data its layout never loads

**Why:** A layout's meta reads `data`, which is the layout's own loader data, and the layout has no loader, so it is always null.

**Fix:** Read the page's data from `pageData`.

Docs: https://nifra.dev/docs/routing

### NF-C041

Server-only export in a route frontend file

**Why:** A route's frontend file exports something that runs only on the server, and that file ships to the browser whole, so the build and the server refuse it.

**Fix:** Move the export to the route's backend half.

Run: `nifra fix --code NF-C041`

Docs: https://nifra.dev/docs/structure

### NF-C042

Layout loader refuses access without a gate

**Why:** A layout loader refuses access, but the layout is not a gate. A client navigation that keeps the layout skips the loader, and an action below it runs without it.

**Fix:** Export `gate = true` from the layout, or move the check into its middleware.

Docs: https://nifra.dev/docs/data

### NF-C043

Merged routes skip the parent's authentication

**Why:** A merged route keeps the hooks of the server that declared it, so the authenticate() or auth plugin applied on this server before merge() never runs for it, and the merged server authenticates none of its routes.

**Fix:** Apply the auth plugin on the merged server, or declare its routes in a group() of this server. A module that is public on purpose takes `// nifra-expect NF-C043: <reason>` on the merge line.

Docs: https://nifra.dev/docs/plugins

### NF-C044

createWebApp passes no copy chunks

**Why:** A production client build moves the app's copy tables into one chunk per locale, and a page loads its locale's chunk from the `copyChunks` its server lists. A createWebApp call with a clientEntry and no copyChunks lists none, so the first page that renders copy fails in production, while `nifra dev`, which never splits, passes.

**Fix:** Pass the client build's `copyChunks` to createWebApp: the generated server manifest exports it (`import { copyChunks } from "./server-manifest"`), and `buildClient()` returns it. A server that never serves those pages takes `// nifra-expect NF-C044: <reason>` on the call.

Docs: https://nifra.dev/docs/i18n

### NF-C045

Route registered outside the typed chain

**Why:** A route registration returns a new type that records the route. Called as a statement of its own, the route runs, but the exported server's type never includes it, so the typed client has no such call.

**Fix:** Chain the registration onto the server's declaration, or declare the routes on their own server() and merge() it. A route kept off the type on purpose takes `// nifra-expect NF-C045: <reason>` above the statement.

Docs: https://nifra.dev/docs/api#typed-client

### NF-C046

Identity-sensitive version skew

**Why:** A package resolves to copies at more than one version, often one in a linked sibling repository that installs its own. Module state splits as with NF-C009, and the two halves can also disagree on behavior. A singleCopy declaration only collapses copies of one version, so it cannot cover this.

**Fix:** Install one version everywhere: align the ranges in every install root that carries a copy, or for nifra packages run `nifra upgrade <version>` in this app and in the linked repository, then install in each.

Docs: https://nifra.dev/docs/troubleshooting

### NF-C047

Island binding name check

**Why:** A data-bind-* attribute inside an island host names a signal its bindIsland setup never declares with state("..."), or a handler the setup does not return. At runtime the binding is skipped with a console warning, so the markup never updates or never reacts.

**Fix:** Fix the name in the markup, or declare it in the setup: state("name", initial) for a signal, a returned handler for data-bind-on.

Docs: https://nifra.dev/docs/islands

### NF-C048

Island binding outside a bindIsland host

**Why:** A data-bind-* attribute sits outside every data-island host, or inside a host mounted with defineIsland or a plain enhancer. Only bindIsland walks bindings, so this one never binds.

**Fix:** Move the element inside a host mounted with bindIsland, or mount that host with bindIsland. A binding inside a data-swap-slot belongs to an island inside that slot, which a swap mounts again.

Docs: https://nifra.dev/docs/islands

### NF-C049

Swap link or form misdeclared

**Why:** A data-swap attribute sits on an element other than <a href> or <form>, its value is not replace:<slot> or append:<slot>, or it is in JSX, where no page can answer a slot swap. The link or form behaves as if the attribute were not there.

**Fix:** Put data-swap on a link with an href or on a form, write replace:<slot> or append:<slot>, and render the page with @nifrajs/web-vanilla.

Docs: https://nifra.dev/docs/islands

### NF-C050

Swap names a slot nothing declares

**Why:** A data-swap link or form names a slot that no data-swap-slot element in the project declares, so there is nothing to swap and every click loads the page normally.

**Fix:** Fix the slot name, or mark the region to refresh with data-swap-slot="<name>" and render its content with slot("<name>", ...).

Docs: https://nifra.dev/docs/islands

### NF-C051

Slot content is not its slot() alone

**Why:** A data-swap-slot element must hold slot("<name>", ...) and nothing else: the server answers a swap with what slot() renders and the client replaces the whole element content with it. Content beside it is lost on the first swap; without it, the server has nothing to answer with; a slot() outside its element swaps nothing.

**Fix:** Make slot("<name>", content) the only content of the element marked data-swap-slot="<name>", and move anything else outside it.

Docs: https://nifra.dev/docs/islands

### NF-C052

Swap URL's page renders no such slot

**Why:** A data-swap link or form goes to a page whose module and layouts render no slot() of the name it swaps, so the server answers with the whole document and every swap loads the page normally.

**Fix:** Point the link or form at the page that renders the slot, or render the slot in that page.

Docs: https://nifra.dev/docs/islands

### NF-C053

Partially prerendered page reads the request

**Why:** A page whose backend half exports shellLoader calls getContext() or tryGetContext(). Its shell is built once and served to every visitor, so the shell check refuses a page that reads the request.

**Fix:** Read the request in a dynamic hole's loader, and render what uses it in that hole. The fix moves a read held in one const, and the one element that uses it, into a new hole.

Run: `nifra fix --code NF-C053`

Docs: https://nifra.dev/docs/partial-prerendering

### NF-C054

Route without a response schema in a published document

**Why:** The project builds an OpenAPI document from its running routes (openapi(), buildOpenApiDocument or toOpenAPI), and a route declares no response schema. The document can only say it answers 200, so a client generated from it, in any language, has no type for the body. nifra's typed client is unaffected: it reads the handler's TypeScript type.

**Fix:** Declare `{ response: ... }` on the route, or build the document with `nifra openapi`, which reads each handler's return type. A route kept out on purpose takes `// nifra-expect NF-C054: <reason>` above the registration.

Docs: https://nifra.dev/docs/api

### NF-C055

zod coerce.boolean() reads request text

**Why:** zod's `z.coerce.boolean()` is `Boolean(value)`. A query, header or cookie value always arrives as text, so every non-empty value reads as true: `?archived=false` and `?archived=0` both do.

**Fix:** Use `z.stringbool()`, which reads `true`/`1`/`yes`/`on` as true, `false`/`0`/`no`/`off` as false, and refuses other text. A use kept on purpose takes `// nifra-expect NF-C055: <reason>` above the call.

Docs: https://nifra.dev/docs/api

### NF-C056

serverFunctions namespace differs from its module's filename

**Why:** The client build calls the namespace named by a `*.fn.ts` file (`todos.fn.ts` posts under `todos`). A `serverFunctions` mount under another word serves routes the stubs never reach, so every call 404s.

**Fix:** Pass the filename's namespace to `serverFunctions` (`serverFunctions("todos", todos)` for `todos.fn.ts`), or rename the file. A mount kept on purpose takes `// nifra-expect NF-C056: <reason>` above the call.

Docs: https://nifra.dev/docs/server-functions

### NF-C057

Internal link to a path no page serves

**Why:** An `<a href>` names a path that no page of the app, no backend route and no file in `public/` serves, so following it is a 404. Nothing fails at build time: a path string is invisible to the types, and a renamed or removed page leaves every link to it dead.

**Fix:** Build the link with `href({ to, params })` (exported by `@nifrajs/web-<framework>/router`): `to` is a route of the app, so a route that does not exist is a compile error. A path some other server answers takes `rawHref(path)`; a link kept on purpose takes `// nifra-expect NF-C057: <reason>` above the attribute.

Docs: https://nifra.dev/docs/routing

### NF-C058

Internal link written as a path string

**Why:** An `<a href>` writes a page's path as a string. It works today, but renaming or removing the page leaves the link dead and nothing fails: `href()` checks a link against the app's routes, a path string is not checked.

**Fix:** Build the link with `href({ to, params, search, hash })`, which `nifra check` and `tsc` hold to the app's routes. A path built elsewhere, such as a CMS link, takes `rawHref(path)`; a link kept on purpose takes `// nifra-expect NF-C058: <reason>` above the attribute. Silence the code for the project with `rules` in `nifra.config`.

Docs: https://nifra.dev/docs/routing

### NF-C059

Route hook names another route than its page's

**Why:** `useSearch(from)` and `useParams(from)` type the page from the route they name. A page that names another route is typed with that route's search or params, and `tsc` cannot tell: both patterns exist. The values read at run time are the page's own.

**Fix:** Name the page's own route: `useSearch("/reports")` in `routes/reports.tsx`. A component shared by several pages names the route of the page it renders in. A pattern kept on purpose takes `// nifra-expect NF-C059: <reason>` above the call.

Docs: https://nifra.dev/docs/routing

### NF-C060

Value cast to Href

**Why:** An `Href` is what `href()` and `rawHref()` return, the two places a link is checked: `href()` against the app's routes at compile time, `rawHref()` against same-origin rules at run time. A cast to `Href` skips both, so a dead or hostile path compiles.

**Fix:** Build the link with `href({ to, params, search })`. A path built elsewhere, such as a CMS link, goes through `rawHref(path)`. A cast kept on purpose takes `// nifra-expect NF-C060: <reason>` above it.

Docs: https://nifra.dev/docs/routing

### NF-C061

SSE stream with no heartbeat under Bun's idle timeout

**Why:** Bun closes a connection that moves no bytes for the listener's `idleTimeoutSec` seconds (10 by default). An SSE stream that sends no ping inside that time is cut whenever its events are further apart, and a test through `app.fetch` never shows it because that path has no listener.

**Fix:** Pass `{ keepAlive: 5_000 }` to the stream so a ping goes out well inside the timeout, or raise the timeout: `withIdleTimeout(c, seconds, work)` from `@nifrajs/core/idle-timeout` under `listen()`, or the `idleTimeout` option of `Bun.serve()`. A stream kept on purpose takes `// nifra-expect NF-C061: <reason>` above the registration.

Docs: https://nifra.dev/docs/api

### NF-C062

ARIA markup assistive technology cannot read

**Why:** An ARIA role or attribute that is misspelled, abstract, given a value it does not take, or missing something its role requires. Browsers drop it without a sound, so the control looks right and a screen reader reads it as plain text, or not at all. `tsc` cannot tell: every attribute type-checks as a string.

**Fix:** Name a concrete ARIA 1.2 role and spell each `aria-*` attribute as the spec does (`aria-labelledby`, not `aria-labeledby`). Give a role what it requires: `role="checkbox"` needs `aria-checked`, `role="slider"` needs `aria-valuenow`. A native element needs none of this: `<input type="checkbox">` carries its own state. A use kept on purpose takes `{/* nifra-expect NF-C062: <reason> */}` above the element in JSX (`// nifra-expect NF-C062: <reason>` outside JSX braces), or `<!-- nifra-expect NF-C062: <reason> -->` in a Vue or Svelte template.

Docs: https://nifra.dev/docs/errors

### NF-C063

Markup assistive technology reads worse than it could

**Why:** Markup that works but reads worse to assistive technology than it could: an image with no `alt`, a positive `tabindex` that jumps the page's tab order, a `<div role="button">` that has to rebuild what `<button>` gives for free, a role the element already has, or an `<html>` with no `lang`.

**Fix:** Describe the image in `alt`, or write `alt=""` when it is decoration. Use `tabindex="0"` or `-1`. Use the native element. Remove the repeated role. Give `<html>` a `lang` naming the page's language, such as `lang="en"` for English. A use kept on purpose takes `{/* nifra-expect NF-C063: <reason> */}` above the element in JSX (`// nifra-expect NF-C063: <reason>` outside JSX braces), or `<!-- nifra-expect NF-C063: <reason> -->` in a Vue or Svelte template; `nifra-expect a11y: <reason>` covers both codes.

Docs: https://nifra.dev/docs/errors

### NF-C064

Island host with no enhancer

**Why:** A data-island host names an id that no mountIslands or enableSwap call in the project lists, so no enhancer ever runs on it. The server-rendered markup stays as it is and nothing warns at runtime.

**Fix:** Add the id to the mountIslands map, or fix the id in the markup (the check lists the ids the project mounts). For a host mounted from outside the project, put `// nifra-expect NF-C064: <reason>` above it. In an html template, put `<!-- nifra-expect NF-C064: <reason> -->` on its own line directly above the host.

Docs: https://nifra.dev/docs/islands

### NF-C065

Island props differ from the enhancer's props type

**Why:** The props a host passes in data-island-props do not match the props type the enhancer declares: a required prop is missing, a prop is not declared, or a literal has another primitive type. The props travel as JSON in an attribute, so TypeScript never compares the two.

**Fix:** Pass what the enhancer's props type declares, or change the type. The check reads plain type literals from enhancer type arguments and inline props parameter annotations. It reads literal JSON, JSX object props, and object literals passed to `islandProps` or `JSON.stringify`. It checks only types and values it can establish from these forms. To keep an intentional difference, put `// nifra-expect NF-C065: <reason>` above the host. In an html template, put `<!-- nifra-expect NF-C065: <reason> -->` on its own line directly above the host.

Docs: https://nifra.dev/docs/islands

### NF-C066

Island attribute binding the runtime refuses

**Why:** A data-bind-attr pair names an attribute the binding runtime refuses to set: an event-handler or srcdoc attribute, a URL attribute on a script, iframe, object, embed, link or base element, or any attribute of an SVG animation element (set, animate, animateMotion, animateTransform: an animation can set a link's href to a script URL). The binding is skipped with a console warning, so the attribute never changes.

**Fix:** Bind a different attribute. A URL that must change on such an element is set by the server render, or by an enhancer you review.

Docs: https://nifra.dev/docs/islands

### NF-D001

Doctor check

**Why:** The doctor gate of `nifra assure` found an undeclared import or a package installed more than once.

**Fix:** Run `nifra doctor` for the details and the fix of each finding.

Run: `nifra doctor`

Docs: https://nifra.dev/docs/troubleshooting

### NF-D002

Mixed nifra versions

**Why:** The workspace pins, installs or runs more than one nifra version. The packages ship together, so a mix runs code and checks written for different releases.

**Fix:** Upgrade everything to the highest version the finding names; the upgrade runs each release's migration steps.

Docs: https://nifra.dev/docs/troubleshooting#mixed-versions

### NF-D003

Stale file: dependencies in bun.lock

**Why:** bun.lock records dependencies a file: package no longer declares. Bun 1.4.2 never reads that package.json again, so it installs the recorded versions beside the declared ones.

**Fix:** Run `bun update <package>` for each package the finding names: it refreshes those entries and keeps every other pin. Deleting an entry by hand makes the next install re-resolve the whole lock.

Docs: https://nifra.dev/docs/troubleshooting#stale-file-links

### NF-H001

Hydration mismatch

**Why:** Hydration replay found a mismatch between the server-rendered HTML and the first client render.

**Fix:** Render the same markup on both sides: move values that differ (time, randomness, browser-only state) into an effect.

Docs: https://nifra.dev/docs/hydration

### NF-H002

Duplicate framework runtime

**Why:** Hydration loaded more than one copy of a framework runtime, so components and hooks from different copies do not work together.

**Fix:** Deduplicate the framework install so one copy serves both server and client.

Docs: https://nifra.dev/docs/hydration

### NF-H003

Stale client build

**Why:** The client build is older than the route source, so hydration would replay an outdated bundle.

**Fix:** Rebuild the client before checking hydration.

Docs: https://nifra.dev/docs/hydration

### NF-H004

Hydration interaction

**Why:** The hydration probe never became interactive, so the page's client code did not finish hydrating.

**Fix:** Open the page and fix the client error that stops hydration.

Docs: https://nifra.dev/docs/hydration

### NF-K001

Contract snapshot drift

**Why:** The contract snapshot no longer matches the routes the backend serves, so a contract change has not been reviewed and locked.

**Fix:** Review the change and snapshot the contracts again.

Run: `nifra contracts snapshot`

Docs: https://nifra.dev/docs/contract

### NF-S001

Fail-open gate

**Why:** A gate's catch block swallows the error, so a failure inside an authorization check lets the request through.

**Fix:** Rethrow, or return an explicit denial from the catch block.

Docs: https://nifra.dev/docs/security

### NF-S002

Non-constant-time secret comparison

**Why:** A secret-like value is compared with `===` or similar, which leaks how much of it matched through timing.

**Fix:** Check the lengths, then compare with a timing-safe comparison.

Run: `nifra fix --code NF-S002`

Docs: https://nifra.dev/docs/security

### NF-S003

Sensitive value in log call

**Why:** A value shaped like personal data or a credential is passed straight to a log call, so it lands in the logs.

**Fix:** Log a redacted form or an identifier instead.

Docs: https://nifra.dev/docs/security

### NF-S004

CORS origin predicate ignores the origin

**Why:** A CORS origin predicate never looks at the origin it is given, so it allows every origin.

**Fix:** List the allowed origins, or test the origin argument.

Docs: https://nifra.dev/docs/security

### NF-S005

External redirect opt-out

**Why:** A redirect opts out of the same-origin default, so a target derived from request input becomes an open redirect.

**Fix:** Make sure the target can never come from request input, then mark it with `// nifra-expect NF-S005: <reason>`.

Docs: https://nifra.dev/docs/security

### NF-S006

Security escape hatch enabled

**Why:** A security option is switched to its unsafe setting; the finding names the option and what it gives up.

**Fix:** Turn the option back on, or mark the reviewed choice with `// nifra-expect NF-S006: <reason>`.

Docs: https://nifra.dev/docs/security

### NF-S007

Secure cookie without a __Host-/__Secure- prefix

**Why:** A Secure cookie has no __Host- or __Secure- prefix, so a subdomain or an insecure page can set a cookie with the same name that shadows it.

**Fix:** Give the cookie a __Host- prefix (or __Secure- when it must reach subdomains).

Docs: https://nifra.dev/docs/security

### NF-S008

Authenticated route validates input before authentication

**Why:** An authenticated route validates its input before it authenticates, so an unauthenticated caller reaches the body parser and reads the validation issues.

**Fix:** Authenticate with app.authenticate(), which runs before validation, or set `validationOrder: "auth-before-validation"` on the route.

Docs: https://nifra.dev/docs/auth

### NF-S009

WebSocket frames parsed without a messageSchema

**Why:** An app.ws() route parses frames itself in message() with no messageSchema, so a client's frame reaches the handler unvalidated and the typed client's send() is untyped.

**Fix:** Declare messageSchema (a discriminated union for several frame kinds): message() receives the parsed, validated value and invalid frames go to onInvalidMessage.

Docs: https://nifra.dev/docs/websockets

### NF-S010

Server answers requests with Host unchecked

**Why:** A Deno or Bun listener answers every request without checking Host, and the project does not say a proxy does. Deno builds the request URL from Host, so a Host such as `evil.test/admin?` routes a `/pub/x` request to `/admin`, past a path rule in front of the app; Bun leaves `req.url` relative, or built on a Host the URL parser refuses.

**Fix:** Set `validateHost: true` on the Nifra server (one header read per request); a bare `Deno.serve` or `Bun.serve` handler has no such option, so check Host there before routing on it. Behind a proxy that checks Host, say so instead: `"hostTopology": "proxied"` in nifra.check.json, or `// nifra-expect NF-S010: <reason>` above the listener.

Docs: https://nifra.dev/docs/security

## Verify

- A `nifra check` finding (`NF-...`): re-run `nifra check`; the fix is done when the code is gone from its output.
- A runtime error (`NIFRA_...` in the dev server or a request): reproduce the failing action, then read `nifra errors`; the fix is done when no entry for the code remains that is not marked `stale`. A `stale` entry predates the last file change, so reproduce the action again to confirm the error does not return.
- A build error (`NIFRA_...` from a standalone build): re-run the build; the fix is done when it exits 0. `nifra errors` reads the dev feed, not standalone build results, and `nifra check` does not reproduce runtime or build failures.
