/**
 * The recognised-failure catalog and its classifier: pure strings, no Node or DOM APIs, so a browser
 * bundle (the error codes page, the dev indicator's prompts) can use it as well as the dev servers.
 */

import { type CatalogEntry, type FixOption, nifraOwned } from "./diagnostic-entry.ts"
import { FAMILY_ENTRIES } from "./diagnostic-families.ts"

export type { FixOption }

/** The codes Solid 2.0 raises at error severity (the rest are warnings), from its diagnostics.json. */
export const SOLID_ERROR_CODES: readonly string[] = [
  "ACTION_CALLED_IN_OWNED_SCOPE",
  "ASYNC_MEMO_ELEMENT",
  "ASYNC_STORE_SETTER",
  "CLEANUP_IN_FORBIDDEN_SCOPE",
  "DYNAMIC_ASYNC_COMPONENT",
  "FRAME_MARKER_CORRUPTED",
  "INVALID_AFFECTS_TARGET",
  "INVALID_REFRESH_TARGET",
  "INVARIANT_VIOLATION",
  "LATE_HEADER_WRITE",
  "MISSING_EFFECT_FN",
  "OPTIMISTIC_WRITE_BEFORE_LOAD",
  "PENDING_ASYNC_UNTRACKED_READ",
  "PRIMITIVE_IN_EFFECT_CALLBACK",
  "PRIMITIVE_IN_FORBIDDEN_SCOPE",
  "REACTIVE_WRITE_IN_OWNED_SCOPE",
  "REACTIVITY_HALTED",
  "SERVER_ERROR_SANITIZED",
  "SETTLED_CLEANUP_UNOWNED",
  "SETTLE_WALK_UNINITIALIZED_SOURCE",
  "SSR_RENDER_ERROR_CONTAINED",
  "SYNC_NODE_RECEIVED_ASYNC",
]

/**
 * The messages Preact's debug build raises. Preact has no code or prefix, so these are the opening
 * words of each message in preact/debug; a test reads the installed source and fails when a release
 * adds one this list does not recognise.
 */
export const PREACT_DEBUG_STEMS: readonly RegExp[] = [
  /^Improper nesting of (?:table|paragraph|interactive content)\./,
  /^Following component has two or more children/,
  /^Calling "this\.(?:setState|forceUpdate)" inside the constructor/,
  /^Can't call "this\.forceUpdate" on an unmounted component/,
  /^(?:getting|setting) vnode\.\w+ (?:is deprecated|is not allowed)/,
  /^PropTypes are not supported on lazy\(\)/,
  /^Failed [\w ]+ type:/,
  /^Invalid argument passed to hook\./,
  /^Undefined (?:component passed to createElement|parent passed to render)/,
  /^Invalid type passed to createElement/,
  /^Component's "\w+" property should be/,
  /^Too many re-renders/,
  /^Hook can only be invoked from render methods/,
  /^Objects are not valid as a child/,
  /^Expected a valid HTML node as a second argument to render/,
  /^Expected a DOM node of type/,
  /^An error occurred in the </,
  /^Add @babel\/plugin-transform-react-jsx-source/,
]
const isPreactDebug = (message: string): boolean =>
  PREACT_DEBUG_STEMS.some((stem) => stem.test(message))
/** The stems Preact throws (an error) rather than logs (a warning). */
const PREACT_THROWN =
  /^(?:Undefined (?:component|parent)|Invalid type passed|Component's "|Too many re-renders|Hook can only|Objects are not valid|Expected a valid HTML node|An error occurred in the <)/

/** What React prints: a `Warning:` prefix (React 18), a react.dev/link warning, or an errors link. */
const REACT_WARNING_PREFIX = /^Warning: /
const REACT_LINK = /https:\/\/react\.dev\/(?:link|errors)\/|Minified React error #\d/
/** React 19 prints these without a `Warning: ` prefix or a link; each opens a message in react-dom. */
const REACT_DOM_WARNING =
  /^(?:React does not recognize the `|Invalid DOM property `|Received `[^`]*` for a non-boolean attribute|Encountered two children with the same key|Each child in a list should have a unique|You provided a `(?:value|checked)` prop to a form field without an `onChange`|A component is changing an? (?:un)?controlled input)/
const isReactMessage = (message: string): boolean =>
  REACT_WARNING_PREFIX.test(message) || REACT_LINK.test(message) || REACT_DOM_WARNING.test(message)
const REACT_THROWN = /https:\/\/react\.dev\/errors\/|Minified React error #\d/

/** A Solid 2.0 dev report: `[CODE] ...` plus the line naming its guide or repair skill. */
const SOLID_CODE = /^\[[A-Z][A-Z0-9_]+\]/
const SOLID_GUIDE =
  /docs\.solidjs\.com\/reference\/solid-js\/diagnostics\/|solid-js\/skills\/reactivity-diagnostics\//
const isSolidReport = (message: string): boolean =>
  SOLID_CODE.test(message) && SOLID_GUIDE.test(message)

/**
 * The recognised-failure catalog. Seeded with the highest-signal nifra failures; extend it as new
 * classes of error earn a stable code. Order matters only in that the first match wins.
 */
export const DIAGNOSTIC_CATALOG: readonly CatalogEntry[] = [
  {
    code: "NIFRA_BACKEND_ONLY_IN_CLIENT",
    match: (_n, m) => m.includes("backend-only module(s) in the client bundle"),
    cause:
      "A module that imports the `@nifrajs/web/backend-only` marker was reachable from a client entry, so it would ship to the browser.",
    fix: "Follow the import chain in the message and move the module under backend/, reached from the route's x.backend.ts (loader/action) or a *.fn.ts server function.",
    docsAnchor: "errors#backend-only-in-client",
    options: [
      {
        label: "Load it on the server",
        fix: "Move the module under backend/ and call it from the route's x.backend.ts loader or action; the page receives the result through loaderOutput/actionOutput.",
      },
      {
        label: "Make it a server function",
        fix: "Move the call into a backend/*.fn.ts server function and import that from the page; the browser bundle gets a stub that calls the server.",
      },
    ],
  },
  {
    code: "NIFRA_BACKEND_IN_CLIENT",
    match: (_n, m) =>
      m.includes("may not ship to a browser") || m.includes("may not reach the browser"),
    cause:
      "Browser code imported a module the zones keep on the server: backend/, a route's x.backend.ts, a server package, or a module outside every zone.",
    fix: "Reach backend code through the route's x.backend.ts (loader/action) or a *.fn.ts server function; put code both sides need in shared/. The message names the import chain.",
    docsAnchor: "errors#backend-in-client",
    options: [
      {
        label: "Load it on the server",
        fix: "Call the backend code from the route's x.backend.ts loader or action and pass the result to the page through loaderOutput/actionOutput.",
      },
      {
        label: "Make it a server function",
        fix: "Wrap the call in a backend/*.fn.ts server function and import that from the page; the browser bundle gets a stub that calls the server.",
      },
      {
        label: "Share pure code",
        fix: "If the imported code needs nothing from the server (no secrets, database or Node APIs), move it to shared/ so both sides may import it.",
      },
    ],
  },
  {
    code: "NIFRA_NODE_BUILTIN_IN_CLIENT",
    match: (_n, m) => m.includes("Node built-in(s) in the client bundle"),
    cause: "A `node:` built-in was reached from a client entry; it has no browser implementation.",
    fix: "Move the code using the built-in under backend/ or into the route's x.backend.ts; the message lists the import chain that pulled it in.",
    docsAnchor: "errors#node-builtin-in-client",
  },
  {
    code: "NIFRA_OUTPUT_SENSITIVE_FIELD",
    match: (n, m) => n === "OutputGuardError" && m.includes("declares sensitive field(s)"),
    cause:
      "An output schema declares a field whose name marks it as a credential (password, token, secret, ...), so the route refuses to send it to the browser.",
    fix: "Remove the field from loaderOutput/actionOutput. If it truly must reach the browser, wrap it in t.declassified(reason, schema). `nifra check` reports the same as NF-C031.",
    docsAnchor: "errors#output-sensitive-field",
    options: [
      {
        label: "Drop the field",
        fix: "Remove the field from loaderOutput/actionOutput so the guard projects it away; the page must not need it.",
      },
      {
        label: "Declassify it",
        fix: "Only if the browser genuinely needs the value: wrap the field's schema in t.declassified(reason, schema) with a reason a reviewer can check.",
      },
    ],
  },
  {
    code: "NIFRA_OUTPUT_UNDECLARED_DEFERRED",
    match: (n, m) => n === "OutputGuardError" && m.includes("deferred value its output schema"),
    cause: "The loader returns a deferred (streamed) value its output schema does not declare.",
    fix: "Declare the field with t.deferred(schema) in loaderOutput, or stop deferring it.",
    docsAnchor: "errors#output-undeclared-deferred",
    options: [
      {
        label: "Declare it as deferred",
        fix: "Declare the field with t.deferred(schema) in loaderOutput so the streamed value is projected like the rest.",
      },
      {
        label: "Stop deferring it",
        fix: "Await the value in the loader and return it directly; its existing schema then covers it.",
      },
    ],
  },
  {
    code: "NIFRA_OUTPUT_RAW_RESPONSE",
    match: (n, m) => n === "OutputGuardError" && /returned a \d+ Response/.test(m),
    cause:
      "A loader or action returned a successful Response; its body would reach the browser without passing the output schema.",
    fix: "Return the data itself so the schema projects it, or serve the raw response from a backend/app.ts route.",
    docsAnchor: "errors#output-raw-response",
    options: [
      {
        label: "Return the data",
        fix: "Return the data itself from the loader or action so its output schema projects it.",
      },
      {
        label: "Serve it from a backend route",
        fix: "Move the raw response to a route in backend/app.ts and have the page link to or fetch it there.",
      },
    ],
  },
  {
    code: "NIFRA_OUTPUT_SCHEMA_MISMATCH",
    match: (n, m) => n === "OutputGuardError" && m.includes("does not match its output schema"),
    cause:
      "Data a loader or action returned does not match its declared output schema, so it was refused before rendering.",
    fix: "Make the returned value match loaderOutput/actionOutput at the listed paths, or update the schema if the shape changed on purpose.",
    docsAnchor: "errors#output-schema-mismatch",
    options: [
      {
        label: "Fix the data",
        fix: "Change what the loader or action returns so it matches loaderOutput/actionOutput at the listed paths.",
      },
      {
        label: "Update the schema",
        fix: "If the shape changed on purpose, update loaderOutput/actionOutput to describe exactly the fields the page needs.",
      },
    ],
  },
  {
    code: "NIFRA_OUTPUT_GUARD",
    match: (n) => n === "OutputGuardError",
    cause:
      "Route data failed the output guard that stands between loaders/actions and the browser.",
    fix: "Declare loaderOutput/actionOutput as a Standard Schema that describes exactly the fields the page needs; `nifra check` flags routes without one (NF-C030).",
    docsAnchor: "errors#output-guard",
  },
  {
    code: "NIFRA_HYDRATION_MISMATCH",
    match: (_n, m) => isHydrationMismatch(m),
    severity: (m) => (/^(?:\[Vue warn\]|\[svelte\])/.test(m) ? "warning" : "error"),
    cause:
      "The browser rendered different markup than the server sent, so the framework discarded or patched the server HTML.",
    fix: "Look for values that differ between server and browser during render (Date.now(), Math.random(), locale formatting, window/localStorage reads, invalid HTML nesting). With happy-dom installed in the project, nifra_hydrate reproduces it with a stable diagnostic.",
    docsAnchor: "errors#hydration-mismatch",
  },
  {
    code: "NIFRA_CDN_HOST_ROUTED",
    match: (_n, m) => m.includes("NIFRA_CDN_HOST_ROUTED"),
    cause:
      "cloudflareWorkersCache was told the Worker serves different content per hostname. Workers Cache keys pages by path, not host, so it would serve one host's page to another.",
    fix: "Put a Cloudflare zone in front instead (cloudflareZone), or serve each hostname from its own Worker.",
    docsAnchor: "errors#cdn-host-routed",
  },
  {
    code: "NIFRA_CDN_TAG_INVALID",
    match: (_n, m) => m.includes("NIFRA_CDN_TAG_INVALID"),
    cause:
      "A route's revalidateTags function returned a tag that is not a letter followed by up to 127 of A-Z a-z 0-9 . _ : / -, more than 32 tags, or something other than an array. Those tags were dropped, so a purge by them reaches nothing.",
    fix: 'Build tags from route params only (`"product:" + params.id`), keep to the allowed characters, and return at most 32.',
    docsAnchor: "errors#cdn-tag-invalid",
  },
  {
    code: "NIFRA_CDN_RATE_LIMITED",
    match: (_n, m) => m.includes("NIFRA_CDN_RATE_LIMITED"),
    cause:
      "The CDN's purge API refused a purge with 429. Cloudflare's Free plan allows 5 purge calls a minute, and Workers Cache always has Free-plan limits.",
    fix: "Nothing, if the line says retrying: the queue waits out Retry-After. If purges keep hitting the limit, batch them (one revalidate call with several tags) or raise debounceMs.",
    docsAnchor: "errors#cdn-rate-limited",
  },
  {
    code: "NIFRA_CDN_PURGE_FAILED",
    match: (_n, m) => m.includes("NIFRA_CDN_PURGE_FAILED"),
    cause:
      "The CDN's purge API refused a purge, or could not be reached. The origin store was purged; the CDN may keep serving the old page until its freshness runs out.",
    fix: "Read the reason in the line: a 401 or 403 means the token lacks purge permission for this zone, project or service; a 5xx or network_error is retried on its own.",
    docsAnchor: "errors#cdn-purge-failed",
  },
  {
    code: "NIFRA_KEEPALIVE_IDENTITY_COOKIE",
    match: (_n, m) => m.includes("NIFRA_KEEPALIVE_IDENTITY_COOKIE"),
    console: true,
    cause:
      "The app keeps pages alive, and a response changed an HttpOnly cookie nifra does not know as a sign-in cookie. If that cookie says who is signed in, a sign-in or sign-out through it leaves the previous visitor's kept pages in every tab, and back shows them.",
    fix: "Name the cookie in createWebApp({ keepAlive: { identityCookies } }) if it carries the session, or in keepAlive.ignoreCookies if it does not.",
    docsAnchor: "errors#keepalive-identity-cookie",
    options: [
      {
        label: "It is the session cookie",
        fix: 'Add it to createWebApp({ keepAlive: { identityCookies: ["<name>"] } }): a response that changes or deletes it rotates the identity epoch, and every tab drops its kept pages.',
      },
      {
        label: "It says nothing about the visitor",
        fix: 'Add it to createWebApp({ keepAlive: { ignoreCookies: ["<name>"] } }) so development stops reporting it.',
      },
      {
        label: "Identity lives in a token",
        fix: "When the session is a bearer token in client storage, call identityChanged() from @nifrajs/web/client at sign-in and sign-out; it drops kept pages in every tab.",
      },
    ],
  },
  {
    code: "NIFRA_KEEPALIVE_DIRECT_CHILD_CSS",
    match: (_n, m) => m.includes("NIFRA_KEEPALIVE_DIRECT_CHILD_CSS"),
    console: true,
    cause:
      "A keepAlive page renders inside two display:contents wrappers, so a selector that reached its top-level element as a direct child (or by its position among siblings) no longer matches it.",
    fix: "Rewrite the selector the message names: a descendant combinator, the wrapper as the parent, or a class on the page's root element.",
    docsAnchor: "errors#keepalive-direct-child-css",
    options: [
      {
        label: "Use a descendant combinator",
        fix: "Write `main section` instead of `main > section`: the wrappers sit between the two.",
      },
      {
        label: "Target the wrapper",
        fix: "Write `[data-nifra-page] > section`: the inner wrapper is the page's parent while it is shown.",
      },
      {
        label: "Put a class on the page root",
        fix: "Give the page's root element a class and select it directly, instead of by its parent or its position.",
      },
    ],
  },
  {
    code: "NIFRA_SOLID_DIAGNOSTIC",
    match: (_n, m) => isSolidReport(m),
    console: true,
    severity: (m) =>
      SOLID_ERROR_CODES.includes(/^\[([A-Z0-9_]+)\]/.exec(m)?.[1] ?? "") ? "error" : "warning",
    cause:
      "Solid 2.0's dev build reported a reactivity mistake: the message opens with Solid's own stable code, then names the owner path, the source location, and the guide for that code.",
    fix: "Read the code in square brackets, open the repair guide the message names (node_modules/solid-js/skills/reactivity-diagnostics/SKILL.md, anchored by the lower-cased code) and apply its repair at the `at` location. Do not silence the report: Solid raises each one for a real defect or a real cost.",
    docsAnchor: "errors#solid-diagnostic",
  },
  {
    code: "NIFRA_COMPONENT_REQUEST",
    match: (n, m) =>
      n === "ServerComponentError" || /^(?:\[nifra\/web\] )?component_[a-z]+$/.test(m),
    cause:
      "A server component request failed. The error carries a `code` (component_input, component_denied, component_version, component_busy, component_timeout, component_cancelled, component_failed, ...) and no further detail.",
    fix: "Read the `code` property on the error, then look for the cause on the server: its logs hold the detail the browser was not given.",
    docsAnchor: "errors#component-request",
    options: [
      {
        label: "component_input (422)",
        fix: "The props or input the page sent failed the component's input schema. Compare what the page passes with the schema in its defineServerComponent call.",
      },
      {
        label: "component_denied (401, 403 or 404)",
        fix: "Either the request was not same-origin (Sec-Fetch-Site was not same-origin, or Origin named another site: call the component from your own pages), or the component's authorize callback refused it (it threw a 401, 403 or 404): check that callback and the caller's credentials.",
      },
      {
        label: "component_version (409)",
        fix: "The browser's build differs from the server's, usually because a deploy landed while the page was open. Reload the page.",
      },
      {
        label: "component_busy (429)",
        fix: "The server's component queue is full: every render slot is busy and the waiting queue is at capacity. Reduce how many components render at once, or the work each one does.",
      },
      {
        label: "component_timeout or component_cancelled",
        fix: "A component outran its deadline (timeout), or the request was aborted first, for example by the visitor navigating away (cancelled). For a timeout, speed up the data the component waits on.",
      },
    ],
  },
  {
    code: "NIFRA_COMPONENT_BUILD",
    match: (_n, m) => m.startsWith("[nifra/components]"),
    cause:
      "The server component build refused the project: a component module, a build entry, or the source graph breaks a rule the compiler relies on.",
    fix: "The message names the rule and, where it can, the file. Fix that one thing and rebuild; the build never ships a bundle it refused.",
    docsAnchor: "errors#component-build",
  },
  {
    code: "NIFRA_PPR_CONTRACT",
    match: (_n, m) => /^\[nifra\/web\] ppr[:. ]/.test(m),
    cause:
      "A partially prerendered route broke the contract that lets its shell be shared between visitors: a visitor-specific loader, a dynamic hole set up wrongly, a nonce in the shell, or an invalid `ppr` option.",
    fix: "The message names the route and the rule. Keep per-visitor data out of the shell (move it into a dynamic boundary, or mark a layout loader `gate`), give every hole a boundaryLoaders entry, and use `csp: createCspPolicy(...)` instead of a per-request nonce.",
    docsAnchor: "errors#ppr-contract",
  },
  {
    code: "NIFRA_DEPLOYMENT_OUTPUT",
    match: (_n, m) => m.startsWith("[nifra/web] deployment"),
    cause:
      "A deployment adapter or the build output it was given broke a deployment rule: an unsafe or oversized output tree, a path collision, or an adapter that does not implement the interface this Nifra build supports.",
    fix: "The message names the adapter, the path or the limit. Emit additions only through the returned files array, keep paths relative and case-distinct, and match the adapter API version this Nifra build supports.",
    docsAnchor: "errors#deployment-output",
  },
  {
    code: "NIFRA_LIVE_CONFIG",
    match: (_n, m) =>
      /^\[nifra\/web\] (?:live(?:-redis)?:|a live frame holds at most|live load busy)/.test(m) ||
      m.includes("livePublisher takes") ||
      m === "malformed revocation",
    cause:
      "The live (real-time) option set is invalid: a missing or short secret, a hub and bus configured together, a path that is not absolute, or a subject that does not return a string.",
    fix: "The message names the option. A secret must be at least 32 bytes (`openssl rand -base64 32`), and `hub` and `bus` are exclusive.",
    docsAnchor: "errors#live-config",
  },
  {
    code: "NIFRA_ROUTE_SLOT_UNAVAILABLE",
    match: (n, m) => n === "RouteSlotLoadError" || m.startsWith("[nifra/web] route-slot"),
    cause:
      "A route slot named a parent route, a slot name, or a target route that is not registered, so the slot cannot render.",
    fix: "Register the route the slot points at, and spell the slot name as the parent route declares it.",
    docsAnchor: "errors#route-slot-unavailable",
  },
  {
    code: "NIFRA_CLIENT_BUILD_NO_GRAPH",
    match: (_n, m) => m.includes("the client build produced no module graph"),
    cause:
      "The client build's result had no metafile (or one without inputs or outputs), so Nifra cannot prove which modules reached the browser. It refuses to write the bundle rather than guess.",
    fix: "Build the client through nifra's build, which keeps the bundler's metafile. A custom build step must request the metafile and pass it through.",
    docsAnchor: "errors#client-build-no-graph",
  },
  {
    code: "NIFRA_VUE_WARNING",
    match: (_n, m) => m.includes("[Vue warn]"),
    console: true,
    severity: "warning",
    cause:
      "Vue's development build warned about a component. The text after `[Vue warn]:` names the problem, and Vue's component trace names the component it happened in.",
    fix: "Fix the component the trace names. Do not silence Vue's warn handler: each warning is raised for a real mistake in that component.",
    docsAnchor: "errors#vue-warning",
  },
  {
    code: "NIFRA_SVELTE_DIAGNOSTIC",
    match: (_n, m) => /\[svelte\] [a-z][a-z0-9_]+|svelte\.dev\/e\/[a-z][a-z0-9_]+/.test(m),
    console: true,
    // Svelte logs a warning as `[svelte] code`; a thrown Svelte error carries only the code and link.
    severity: (m) => (m.includes("[svelte] ") ? "warning" : "error"),
    cause:
      "Svelte's development build reported a mistake. The identifier after `[svelte]` (or at the end of the https://svelte.dev/e/ link) is Svelte's own stable code.",
    fix: "Open https://svelte.dev/e/<code> for the cause and the repair, then fix the component the message locates.",
    docsAnchor: "errors#svelte-diagnostic",
  },
  {
    code: "NIFRA_REACT_WARNING",
    match: (_n, m) => isReactMessage(m),
    console: true,
    // The dev feed names a console report "Warning". A thrown error (an invalid hook call links to
    // react.dev/link too) and a react.dev/errors or minified message stay errors.
    severity: (m, n) => (n === "Warning" && !REACT_THROWN.test(m) ? "warning" : "error"),
    cause:
      "React reported a mistake: a development warning that links to react.dev/link/..., or an error whose message links to react.dev/errors/... (a minified production error).",
    fix: "Open the link in the message for the cause and the repair, then fix the component React's trace names. A react.dev/errors message is a thrown error, not a warning.",
    docsAnchor: "errors#react-warning",
  },
  {
    code: "NIFRA_PREACT_DIAGNOSTIC",
    match: (_n, m) => isPreactDebug(m),
    console: true,
    severity: (m) => (PREACT_THROWN.test(m) ? "error" : "warning"),
    cause:
      "Preact's debug build reported a mistake in a component: invalid nesting, a duplicate key, an invalid element type, a hook outside render, a render loop, or a prop of the wrong type. Preact has no stable code, so the message text is the identifier.",
    fix: "Fix the component the message names; Preact appends its component stack. Do not remove preact/debug to quiet it: each message is raised for a real mistake.",
    docsAnchor: "errors#preact-diagnostic",
  },
  {
    code: "NIFRA_MEMORY_STORE_IN_PRODUCTION",
    match: (_n, m, fromNifra) =>
      nifraOwned(m, fromNifra, /\bis per-instance and (?:unsafe|can't dedupe)\b/),
    cause:
      "An in-memory store (rate-limit MemoryStore, MemoryIdempotencyStore, MemoryResponseCache, MemorySessionStore) was created in production. Each instance keeps its own copy, so limits, de-duplication, cached responses or sessions differ per instance and are lost on restart.",
    fix: "Pass a shared store (for example Redis-backed), or pass { allowInProduction: true } when the app runs as a single instance.",
    docsAnchor: "errors#memory-store-in-production",
    options: [
      {
        label: "Use a shared store",
        fix: "Give the middleware or session manager a store every instance reads and writes (Redis or another shared backend) instead of the Memory* default.",
      },
      {
        label: "Single instance only",
        fix: "Pass { allowInProduction: true } when exactly one instance serves traffic and losing state on restart is acceptable.",
      },
    ],
  },
  {
    code: "NIFRA_CORS_CREDENTIALS_WILDCARD",
    match: (_n, m, fromNifra) =>
      nifraOwned(m, fromNifra, /`credentials: true` cannot be combined with/),
    cause:
      'cors() was given `credentials: true` with `origin: "*"`. Browsers refuse a wildcard origin on a credentialed request, so the combination can never work.',
    fix: "List the explicit origin(s) that may send credentials instead of the wildcard.",
    docsAnchor: "errors#cors-credentials-wildcard",
  },
  {
    code: "NIFRA_SECRET_TOO_SHORT",
    match: (_n, m, fromNifra) => nifraOwned(m, fromNifra, /\bsecret must be at least \d+ bytes\b/),
    cause:
      "A signing secret is shorter than the 32 bytes (256 bits) nifra requires, so it is refused instead of used.",
    fix: "Generate one with `openssl rand -base64 32` and load it from the environment.",
    docsAnchor: "errors#secret-too-short",
  },
  {
    code: "NIFRA_MIDDLEWARE_ORDER",
    match: (_n, m, fromNifra) =>
      nifraOwned(m, fromNifra, /must be installed before the routes it protects/),
    cause:
      "A middleware that protects routes was installed after the routes it should guard, so those routes were registered without it.",
    fix: "Call app.use(...) for it before registering the routes it protects.",
    docsAnchor: "errors#middleware-order",
  },
  {
    code: "NIFRA_CONTEXT_STORAGE_MISSING",
    match: (_n, m, fromNifra) => nifraOwned(m, fromNifra, /^contextStorage: no active context/),
    cause:
      "getContext() ran outside a request that went through contextStorage(): the middleware was not installed before the route, or the code ran outside any request (a partially prerendered shell is built outside every request).",
    fix: "Add app.use(contextStorage()) before the route and call getContext() during that request. For a PPR shell, read the request in a dynamic boundary's loader instead.",
    docsAnchor: "errors#context-storage-missing",
  },
  {
    code: "NIFRA_SESSION_STORE_CONSISTENCY",
    match: (_n, m, fromNifra) =>
      nifraOwned(m, fromNifra, /sessions require a strongly consistent store/),
    cause:
      "The session manager was given an eventually consistent store such as KVSessionStore. Logout and rotation need a read to see the write that revoked a session, which that kind of store does not promise.",
    fix: "Use a strongly consistent shared SessionStore.",
    docsAnchor: "errors#session-store-consistency",
  },
  {
    code: "NIFRA_ROUTE_CONFIG",
    match: (n) => n === "RouteConfigError",
    cause:
      "A route is misconfigured, and registration refuses it at boot rather than failing on the first request. The error's `code` names the rule (DUPLICATE_ROUTE, INVALID_PATH, INVALID_METHOD, WILDCARD_NOT_LAST, INVALID_IDEMPOTENCY, ...).",
    fix: "Read the `code` and the message, then correct the route definition they name. The server does not start until the route is valid.",
    docsAnchor: "errors#route-config",
  },
  {
    code: "NIFRA_WIRE_INVALID",
    match: (n, m) =>
      n === "WireDecodeError" || n === "TransportCodecError" || /^malformed wire\b/.test(m),
    cause:
      "A value could not be encoded or decoded on the typed wire: a malformed frame, an unsupported codec or content type, a payload over maxBytes, or a value that is not JSON serializable.",
    fix: "Send values the wire can carry, from a client built against this server's contract. For an oversized payload, send less or raise maxBytes on purpose.",
    docsAnchor: "errors#wire-invalid",
  },
  {
    code: "NIFRA_STORAGE_KEY",
    match: (n) => n === "StorageKeyError",
    cause:
      'A storage key was refused before any read or write: it is empty or over 1024 characters, is absolute, has a backslash, NUL, ".." or an empty or "." segment, escapes the storage root, or reaches the file through a symbolic link, a moved root directory or an untrusted writable directory.',
    fix: "Build keys as relative, forward-slash paths that stay under the storage root, and never put unchecked user input into a key. For a symbolic link, a moved root or an untrusted directory, the message names what to check on the filesystem.",
    docsAnchor: "errors#storage-key",
  },
  {
    code: "NIFRA_STORAGE_READ_LIMIT",
    match: (_n, m) => /^R2Storage object exceeds maxReadBytes/.test(m),
    cause:
      "An R2 object is larger than maxReadBytes (or reports invalid size metadata), so R2Storage refuses to buffer it. The key itself was valid.",
    fix: "Raise maxReadBytes on the R2Storage if objects of that size are expected; otherwise find why the object is larger than the limit.",
    docsAnchor: "errors#storage-read-limit",
  },
  {
    code: "NIFRA_OPENAPI_IMPORT",
    match: (n) => n === "OpenAPIImportError",
    cause:
      "The OpenAPI document cannot be imported: it is malformed, uses a version outside 3.0.x, 3.1.x and 3.2.x, exceeds an import limit, or holds a construct Nifra cannot represent (a parameter $ref, an unsupported path template).",
    fix: "The message names the path in the document. Fix that part, and inline parameter $refs before importing: refs are never resolved.",
    docsAnchor: "errors#openapi-import",
  },
  {
    code: "NIFRA_ASSURANCE_INPUT",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^(?:route assurance|capability assurance|project evidence|execution policy|nifra manifest|route capabilities|webProjectEvidence\(\)|assure\(\)):|^\[nifra\/web\] (?:cannot compose assurance evidence|cyclic composed assurance evidence)/,
      ),
    cause:
      "An assurance, capability, manifest or evidence declaration is malformed: an id, path glob, scope, provenance, method or policy field outside what the registry accepts.",
    fix: "The message names the field and the accepted form (lowercase dot/dash ids, absolute path globs, a known scope). Correct the declaration; `nifra check` reports the same project-wide.",
    docsAnchor: "errors#assurance-input",
  },
  {
    code: "NIFRA_EFFECT_INVALID",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^(?:effect (?:ledger|reconciliation|store)|durable effect|owned effect|saga\b|reconciliation (?:lease|limit)|causality|channel:)/,
      ),
    cause:
      "An effect, saga or durable-journal declaration, or the store behind it, broke its contract: a value out of range, a missing step, or a store that is not durable where durability is required.",
    fix: 'The message names the part. Where it says `store.durability === "durable"`, back the journal with a durable store; otherwise correct the id, cost or limit it names.',
    docsAnchor: "errors#effect-invalid",
  },
  {
    code: "NIFRA_CONTENT_INVALID",
    match: (_n, m) => /^@nifrajs\/content(?:\/mdx)?:/.test(m),
    cause:
      "A content collection, its baked index, or an MDX extension is malformed or out of range.",
    fix: "The message names the index, bucket or extension. Correct the collection definition it names.",
    docsAnchor: "errors#content-invalid",
  },
  {
    code: "NIFRA_BUILD_PLUGIN",
    match: (_n, m) =>
      /^\[nifra\/(?:web|web-vue|web-svelte|web-solid)(?:\/[\w-]+)?\] (?:CSS Modules|the installed @babel\/core|failed to compile|template error|style error|an SVG component|the refresh pass emitted|no slot node)/.test(
        m,
      ) || m.startsWith("@nifrajs/web-svelte/mdx:"),
    cause:
      "A build plugin (CSS Modules, SCSS, StyleX, a Vue single-file component, Svelte MDX) failed on a file or is missing a compiler dependency.",
    fix: "The message names the file and the compiler's own reason. Fix that source, or install the compiler package it says is missing or incompatible.",
    docsAnchor: "errors#build-plugin",
  },
  {
    code: "NIFRA_BUILD_OUTPUT",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^(?:\[nifra(?:\/web)?\] (?:client build failed|server build|build produced no|Vite SSR build|Vite build produced no|outDir|publicDir|public files?\b|could not restore|buildTarget|generateServerEntry|cssCodeSplit|failed to process|failed to optimize|the server build emitted|expected .* entry-point outputs|Image sources changed|an image plugin is configured|prerenderPaths applies|vercelRuntime is only|.* is a filesystem root|.* the build clears|the installed @stylexjs)|\[nifra\/web\] .*import\.meta\.glob|\[nifra\] Bun.s dev server returned)/,
      ),
    cause:
      "The client or server build, or the directory it writes to, broke a rule: no entry-point output, an output or public directory that is a symlink, escapes its root or overlaps the other, a build target the chosen option does not fit, or a glob pattern the bundler cannot read.",
    fix: "The message names the path, target or option. Move the output or public directory, drop the option the target does not support, or give the bundler a literal pattern.",
    docsAnchor: "errors#build-output",
  },
  {
    code: "NIFRA_ROUTE_FILES",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^(?:\[nifra\/web\] (?:duplicate route|ambiguous _404|overlapping routes|optional "|catch-all "|route ".*" sets both|".*" exports an `action`|".*" has "#" or "\?"|.* renders inside layouts|static boundary |query keys beginning|no client status boundary|no frontend dedupe policy)|\[nifra\/fn\] |nifra: no error module)/,
      ),
    cause:
      "The file routes, or a route's exports, break a convention the router relies on: two files map to one URL, two `_404` files answer the same URLs, an optional segment is mixed with literal text, a layout exports an `action`, or a route turns off both server rendering and hydration.",
    fix: "The message names the files and the rule. Keep one file per URL, one `_404` per scope, and put actions in route files, not layouts.",
    docsAnchor: "errors#route-files",
  },
  {
    code: "NIFRA_I18N_CONFIG",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^(?:\[nifra\/i18n\]|defineLocales:|pathnames:|copy(?:\.pick|\.id|\.format)?:|defineCopy:|pageLocales |localeDetector:|alternates:|sitemap:|robots:)/,
      ),
    cause:
      "The locale, copy-table or localized-path configuration breaks a rule: a duplicate id or canonical pathname, two locales sharing an hreflang, a draft default locale, or a copy value of the wrong kind.",
    fix: "The message names the locale, table or pathname. Make the ids and pathnames unique and give each locale its own hreflang.",
    docsAnchor: "errors#i18n-config",
  },
  {
    code: "NIFRA_JOBS_INVALID",
    match: (n, m, fromNifra) =>
      n === "JobError" ||
      nifraOwned(m, fromNifra, /^(?:snapshot|dead-letter-view|jobs|duplicate job)\b/),
    cause:
      "A job, its payload, or a dead-letter record cannot be stored as data: a duplicate job name, an Error instance, a custom prototype, an accessor, or a record the dead-letter view cannot read.",
    fix: "Make the payload plain data (objects, arrays, strings, numbers, booleans), and give each job one name.",
    docsAnchor: "errors#jobs-invalid",
  },
  {
    code: "NIFRA_SCHEMA_DECLARATION",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^(?:\[nifra\/schema\]|t\.(?:file|array|form|headers|declassified):|.*: "__proto__" cannot be a field name)/,
      ),
    cause:
      "A schema declaration uses something the schema builder cannot accept: a file list nested in a list, a file field outside t.form(), a header name that is not lower-cased, a declassified field with no reason, or a feature precompile refuses (custom registry kinds, runtime-only metadata).",
    fix: "The message names the declaration and what it expects. Declare file fields in t.form(), give declassified a reason, and keep precompiled schemas to plain, compilable shapes.",
    docsAnchor: "errors#schema-declaration",
  },
  {
    code: "NIFRA_ASSET_INVALID",
    match: (_n, m, fromNifra) =>
      nifraOwned(
        m,
        fromNifra,
        /^(?:loadGoogleFont:|pwaManifest:|\[nifra\/service-worker\]|fontFace:|manifestLink:)/,
      ),
    cause:
      "A font, web manifest or service-worker asset was refused: a download from a non-allowed host or over its size limit, a stylesheet with no usable font files, an unknown manifest value, or a path with characters an asset path cannot hold.",
    fix: "The message names the family, URL or field. Request only Google-hosted fonts within the limits, and use the manifest values and path characters it lists.",
    docsAnchor: "errors#asset-invalid",
  },
  ...FAMILY_ENTRIES,
  {
    code: "NIFRA_OPTION_INVALID",
    // A TypeError or RangeError a nifra package throws is an argument it refused; a plain Error needs
    // the wording of a refusal.
    match: (n, m, fromNifra) =>
      (fromNifra || /^(?:\[nifra(?:\/[\w/-]+)?\]|pwaManifest:|loadGoogleFont:)/.test(m)) &&
      (n === "TypeError" ||
        n === "RangeError" ||
        (n === "Error" &&
          /\b(?:must|needs|takes|requires|expects|invalid|is not|is empty|cannot be empty|not supported|is required|exceeds|out of range|unknown option|already registered|duplicate|unsafe|too large|configure at least one|unknown mark|tier prefix)\b/.test(
            m,
          ))),
    cause:
      "An option passed to a nifra function (createWebApp, a middleware, a route, the CDN, ISR, a manifest) has a value outside what it accepts.",
    fix: "The message names the option and the shape it accepts. Correct the value at the call that sets it; nothing is silently coerced.",
    docsAnchor: "errors#option-invalid",
  },
  {
    code: "NIFRA_SCHEMA_PARSE",
    match: (n, m) =>
      n === "SchemaError" ||
      /failed to (parse|validate)|invalid_type|expected .* received/i.test(m),
    cause: "Data crossing a boundary did not match its declared schema.",
    fix: "Check the value against the schema at the failing boundary (loader input, search params, or request body); parse-don't-cast means the shape must match exactly.",
    docsAnchor: "errors#schema-parse",
  },
]

// What each framework says when the browser's first render disagrees with the server HTML:
// React 19 / 18 (dev and minified #418/#423/#425), Vue, Svelte 5, Solid and preact/debug.
const HYDRATION_MESSAGES: readonly RegExp[] = [
  /hydrat(?:ion|ed|e)\b[^\n]*(?:mismatch|failed|did not match|didn't match)/i,
  // Svelte's warning codes. The lookbehind keeps one inside a longer name from matching: Vue's
  // feature-flag warning names `__VUE_PROD_HYDRATION_MISMATCH_DETAILS__`.
  /(?<!\w)hydration_(?:mismatch|html_changed|attribute_changed)\b/,
  /hydration key/i,
  /error while hydrating|failed to hydrate|Text content did not match|Expected server HTML to contain/i,
  /caused by the SSR'd HTML/,
  /Minified React error #(?:418|423|425)\b/,
]

/** True when a console `message` reports a catalog failure that is only ever logged, never thrown. */
export function isConsoleDiagnostic(message: string): boolean {
  return DIAGNOSTIC_CATALOG.some(
    (entry) => entry.console === true && entry.match("", message, false),
  )
}

/** True when `message` is a framework's report of a server/browser render mismatch. */
export function isHydrationMismatch(message: string): boolean {
  return HYDRATION_MESSAGES.some((pattern) => pattern.test(message))
}

/** Classify an error name+message against the catalog; falls back to the generic unhandled code. */
export function classify(
  name: string,
  message: string,
  fromNifra = false,
): {
  code: string
  cause?: string
  fix?: string
  docsAnchor?: string
  fixOptions?: readonly FixOption[] | undefined
  severity?: "warning" | undefined
} {
  const hit = DIAGNOSTIC_CATALOG.find((e) => e.match(name, message, fromNifra))
  if (hit === undefined) return { code: "NIFRA_UNHANDLED" }
  return {
    code: hit.code,
    cause: hit.cause,
    fix: hit.fix,
    docsAnchor: hit.docsAnchor,
    fixOptions: hit.options,
    severity: severityOf(hit, message, name) === "warning" ? "warning" : undefined,
  }
}

const severityOf = (entry: CatalogEntry, message: string, name: string): "error" | "warning" =>
  typeof entry.severity === "function" ? entry.severity(message, name) : (entry.severity ?? "error")
