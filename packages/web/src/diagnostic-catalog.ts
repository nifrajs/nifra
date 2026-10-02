/**
 * The recognised-failure catalog and its classifier: pure strings, no Node or DOM APIs, so a browser
 * bundle (the error codes page, the dev indicator's prompts) can use it as well as the dev servers.
 */

/** One labeled way to fix a recognised failure. */
export interface FixOption {
  readonly label: string
  readonly fix: string
}

/** A recognised failure shape: a stable code plus the plain-language cause/fix/anchor to attach. */
interface CatalogEntry {
  readonly code: string
  readonly match: (name: string, message: string) => boolean
  readonly cause: string
  readonly fix: string
  readonly docsAnchor: string
  readonly options?: readonly FixOption[]
}

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
    cause:
      "The browser rendered different markup than the server sent, so the framework discarded or patched the server HTML.",
    fix: "Look for values that differ between server and browser during render (Date.now(), Math.random(), locale formatting, window/localStorage reads, invalid HTML nesting). Run nifra_hydrate to reproduce it with a stable diagnostic.",
    docsAnchor: "errors#hydration-mismatch",
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
  /hydration_mismatch|hydration key/i,
  /error while hydrating|failed to hydrate|Text content did not match|Expected server HTML to contain/i,
  /caused by the SSR'd HTML/,
  /Minified React error #(?:418|423|425)\b/,
]

/** True when `message` is a framework's report of a server/browser render mismatch. */
export function isHydrationMismatch(message: string): boolean {
  return HYDRATION_MESSAGES.some((pattern) => pattern.test(message))
}

/** Classify an error name+message against the catalog; falls back to the generic unhandled code. */
export function classify(
  name: string,
  message: string,
): {
  code: string
  cause?: string
  fix?: string
  docsAnchor?: string
  fixOptions?: readonly FixOption[]
} {
  const hit = DIAGNOSTIC_CATALOG.find((e) => e.match(name, message))
  if (hit === undefined) return { code: "NIFRA_UNHANDLED" }
  return {
    code: hit.code,
    cause: hit.cause,
    fix: hit.fix,
    docsAnchor: hit.docsAnchor,
    ...(hit.options === undefined ? {} : { fixOptions: hit.options }),
  }
}
