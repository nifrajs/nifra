/** What `nifra explain NF-xxxx` says about each built-in rule code. */
import type { BuiltInCode } from "./codes.ts"

export interface RuleExplanation {
  /** What the rule reports and why it matters. */
  readonly why: string
  /** What to do about a finding. */
  readonly fix: string
  /** A command that makes or starts the fix, when one does. */
  readonly command?: string
  /** The site page that covers it, as a path. */
  readonly docs: string
}

export const RULE_EXPLANATIONS: Readonly<Record<BuiltInCode, RuleExplanation>> = Object.freeze({
  "NF-C001": {
    why: "The project does not typecheck, or the typecheck could not run (no tsconfig.json, no TypeScript install, or source files outside the program). Every typed contract nifra keeps between frontend and backend rests on this check.",
    fix: "Fix the reported TypeScript errors; install TypeScript with `bun add -d typescript` and add a tsconfig.json that includes every source folder when the check did not run.",
    docs: "/docs/types-first",
  },
  "NF-C002": {
    why: "A hand-written fetch(), EventSource or WebSocket calls the project's own API, so the compiler cannot see when the route it calls changes.",
    fix: "Call the route through client<typeof app> (`.subscribe()` for an SSE route, `.ws()` for a socket route), or mark a call no typed client covers with `// nifra-expect NF-C002: <reason>`.",
    docs: "/docs/types-first",
  },
  "NF-C003": {
    why: 'client("...") without a type argument types every response as unknown, so frontend and backend can drift without a compile error.',
    fix: 'Write client<typeof app>("...") or client(contract, url).',
    docs: "/docs/types-first",
  },
  "NF-C004": {
    why: "Browser code (a route's frontend half, frontend/ or shared/) imports server-only code, which would ship to the browser or fail the build.",
    fix: "Reach the server code from the route's backend half (x.backend.ts) or through a *.fn.ts server function.",
    docs: "/docs/structure",
  },
  "NF-C005": {
    why: "An import names an export that moved to another module in a nifra release, so it no longer resolves.",
    fix: "Import it from the module the finding names.",
    command: "nifra fix --code NF-C005",
    docs: "/docs/cli",
  },
  "NF-C006": {
    why: "SQL built by interpolating a value into the statement text turns that value into SQL, so a caller who controls it can inject statements.",
    fix: "Pass the value as a bound parameter, or use the driver's tagged template, which binds each substitution; mark reviewed SQL with `// nifra-expect NF-C006: <reason>`.",
    docs: "/docs/database",
  },
  "NF-C007": {
    why: "A route handler returns a raw Response, so the typed client infers `data: never` and drift detection is lost for that route.",
    fix: "Return a plain object (set status, headers and cookies on c.set), use app.sse() for a stream, or declare `{ response: t.... }`; mark an intended file or redirect with `// nifra-expect NF-C007: <reason>`.",
    docs: "/docs/api",
  },
  "NF-C008": {
    why: "Source imports a package package.json does not declare. It resolves today only through a hoisted or global install, and a clean install will not have it.",
    fix: "Declare it with `bun add <package>`.",
    docs: "/docs/troubleshooting",
  },
  "NF-C009": {
    why: "A package resolves to more than one physical copy, so module-level state (contexts, registries, instanceof checks) splits between them.",
    fix: "Deduplicate the installs so each resolves to one path, or declare the package single-copy in package.json's nifra.singleCopy and preload the register module.",
    docs: "/docs/troubleshooting",
  },
  "NF-C010": {
    why: "A workspace package's build output is missing or older than its source; Bun reads the source while Vite SSR and Node read the stale build.",
    fix: "Rebuild the package with its own build script.",
    command: "nifra fix --code NF-C010",
    docs: "/docs/troubleshooting",
  },
  "NF-C011": {
    why: "A plugin or condition is configured for a bundler phase that never sees it: Vite, Bun's client and server builds, and the server bundle each read their own settings.",
    fix: "Move the setting to the phase the finding names.",
    docs: "/docs/dev",
  },
  "NF-C012": {
    why: "server-manifest.ts no longer matches routes/. A worker without a filesystem serves the baked route table, so the drift breaks routes at the edge without an error.",
    fix: "Regenerate it and commit it.",
    command: "nifra sync-manifest",
    docs: "/docs/deployment",
  },
  "NF-C013": {
    why: "nifra.manifest.json, the trust artifact reviewers sign off on, is missing, invalid or out of date with the app.",
    fix: "Regenerate it, review the change, and commit it.",
    command: "nifra manifest emit",
    docs: "/docs/verification",
  },
  "NF-C014": {
    why: "A route's declared effects or capabilities do not match what its code reaches through approved adapters.",
    fix: "Align the route's declaration with the adapters it uses; never route an effect around its owned seam.",
    docs: "/docs/capabilities",
  },
  "NF-C015": {
    why: "The capability assurance configuration could not be loaded or evaluated, so no route was checked against it.",
    fix: "Fix the error the finding quotes in nifra.assurance.ts.",
    docs: "/docs/verification",
  },
  "NF-C016": {
    why: "nifra.check.json could not be parsed, so the settings in it, such as its external-mount allowlist, were ignored.",
    fix: "Fix the JSON error the finding quotes.",
    docs: "/docs/cli",
  },
  "NF-C017": {
    why: "A rule pack failed to load or threw while scanning; the rule registry fails closed rather than report a partial result as clean.",
    fix: "Fix or remove the rule pack the error names, then re-run the check.",
    docs: "/docs/cli",
  },
  "NF-C018": {
    why: "A route path segment collides with a key the typed client proxy reserves, so dot access on the client cannot reach that route.",
    fix: "Rename the segment, or call the parent node with the segment as the finding shows.",
    command: "nifra fix --code NF-C018",
    docs: "/docs/routing",
  },
  "NF-C019": {
    why: "The same method and path are registered twice in one file, and which registration serves is undefined.",
    fix: "Remove or rename one of them.",
    docs: "/docs/routing",
  },
  "NF-C020": {
    why: "An island enhancer adds an event listener but returns no cleanup, so the listener outlives the island on a client navigation.",
    fix: "Return a function that removes the listener.",
    docs: "/docs/islands",
  },
  "NF-C021": {
    why: "A nano binding's returned disposer is discarded, so the binding outlives its component and leaks on soft navigation.",
    fix: "Collect the disposer and call it on teardown.",
    docs: "/docs/nano",
  },
  "NF-C022": {
    why: "bindList is keyed by the array index, so adding, removing or reordering items reuses the wrong node and its state.",
    fix: "Key each item by a stable id.",
    docs: "/docs/nano",
  },
  "NF-C023": {
    why: "A computed or effect reads a signal its deps array does not list, so it does not update when that signal changes.",
    fix: "Add the missing signals to the deps array.",
    docs: "/docs/nano",
  },
  "NF-C024": {
    why: "Two route patterns match a common path (the finding shows one), so one shadows the other for some requests.",
    fix: "Make the patterns disjoint, or mark a deliberate overlap with `// nifra-expect NF-C024: <reason>`.",
    docs: "/docs/api",
  },
  "NF-C025": {
    why: "The route-overlap analysis ran out of its safety budget before it could prove two patterns disjoint.",
    fix: "Simplify the patterns, or after reviewing them by hand mark the pair with `// nifra-expect NF-C025: <reason>`.",
    docs: "/docs/api",
  },
  "NF-C026": {
    why: "A character after a route param reads as literal text, not as a modifier; a `?` in the middle of a path makes the route unreachable.",
    fix: "Use optional params only as trailing whole segments (`/users/:id?`), and a constraint as one character class (`:id{[0-9]+}`).",
    docs: "/docs/api",
  },
  "NF-C027": {
    why: "A page route sits under the path the backend is mounted at. The backend answers every request there first, and its 404 is final, so the page never renders.",
    fix: "Move the page, serve the URL from backend/app.ts, or mount the backend elsewhere with apiPrefix in backend/framework.ts.",
    docs: "/docs/backends",
  },
  "NF-C028": {
    why: "A file imports across a zone boundary the project declares, such as browser code reaching backend code, or the zone configuration itself is invalid.",
    fix: "Import through the boundary's public entry, or move the code to the zone that may use it.",
    docs: "/docs/structure",
  },
  "NF-C029": {
    why: "Browser code reads a private environment variable. Browser code may read only NODE_ENV and the variables named with the app's public prefix; anything else is a server secret.",
    fix: "Read it in a loader, an action or under backend/, or rename it with the public prefix when it is meant for the browser.",
    docs: "/docs/structure",
  },
  "NF-C030": {
    why: "A loader or action returns data to the browser without an output schema, so nothing limits which fields leave the server.",
    fix: "Export the schema beside it; the fix drafts one from the function's return type.",
    command: "nifra fix --code NF-C030",
    docs: "/docs/data",
  },
  "NF-C031": {
    why: "An output schema declares a field whose name usually holds a credential or a personal identifier, so it would be sent to the browser.",
    fix: 'Remove the field, or wrap its schema in t.declassified("why it may reach the browser", ...).',
    docs: "/docs/data",
  },
  "NF-C032": {
    why: "Code that reaches the browser carries what looks like a credential.",
    fix: "Read it from the environment on the server, and rotate it if it was ever committed.",
    docs: "/docs/security",
  },
  "NF-C033": {
    why: "A generated output schema no longer matches what its loader or action returns, or it could not be compared, so the output guard may drop or admit the wrong fields.",
    fix: "Regenerate the schemas and review the change.",
    command: "nifra schemas --write",
    docs: "/docs/data",
  },
  "NF-C034": {
    why: "A root status page imports the root layout to wrap itself, but status pages render inside their layouts, so the layout renders twice.",
    fix: "Remove the wrap, or export `inLayouts = false` from the page.",
    docs: "/docs/routing",
  },
  "NF-C035": {
    why: "backend/framework.ts sets no apiPrefix, so the backend is reachable from loaders only and a browser call to /api reaches page routing.",
    fix: 'Export `apiPrefix = "/api"` to serve it over HTTP, or `apiPrefix = ""` to keep it loader-only.',
    command: "nifra fix --code NF-C035",
    docs: "/docs/backends",
  },
  "NF-C036": {
    why: "A route's path is computed in a way the static scan cannot read, so capability provenance and the route lints do not see that route.",
    fix: "Write the path as a string literal or a module-level const, or mark a deliberately computed path with `// nifra-expect NF-C036: <reason>`.",
    docs: "/docs/capabilities",
  },
  "NF-C037": {
    why: 'package.json declares `"nifra": { "kind": "api" }` over a directory with web config, which would switch off the zone checks a web app needs.',
    fix: 'Remove "kind", or give the web app its own package.json.',
    docs: "/docs/structure",
  },
  "NF-C038": {
    why: "The root layout is still at its retired location. Until it moves, the contract gate does not run for the app and the commands that load it refuse it.",
    fix: "Move it to the location the finding names.",
    command: "nifra migrate layout --write",
    docs: "/docs/migrate-5",
  },
  "NF-C039": {
    why: "An app implements contract operations that backend/app.ts does not serve, so the contract lock, the typed client checks and nifra routes cannot see them; or the contract cannot be read at all.",
    fix: "Mount the implementing app in backend/app.ts, built with stub dependencies if it needs any, and keep each operation's method and path as string literals.",
    docs: "/docs/types-first#stub-entry",
  },
  "NF-C040": {
    why: "A layout's meta reads `data`, which is the layout's own loader data, and the layout has no loader, so it is always null.",
    fix: "Read the page's data from `pageData`.",
    docs: "/docs/routing",
  },
  "NF-C041": {
    why: "A route's frontend file exports something that runs only on the server, and that file ships to the browser whole, so the build and the server refuse it.",
    fix: "Move the export to the route's backend half.",
    command: "nifra fix --code NF-C041",
    docs: "/docs/structure",
  },
  "NF-C042": {
    why: "A layout loader refuses access, but the layout is not a gate. A client navigation that keeps the layout skips the loader, and an action below it runs without it.",
    fix: "Export `gate = true` from the layout, or move the check into its middleware.",
    docs: "/docs/data",
  },
  "NF-D001": {
    why: "The doctor gate of `nifra assure` found an undeclared import or a package installed more than once.",
    fix: "Run `nifra doctor` for the details and the fix of each finding.",
    command: "nifra doctor",
    docs: "/docs/troubleshooting",
  },
  "NF-D002": {
    why: "The workspace pins, installs or runs more than one nifra version. The packages ship together, so a mix runs code and checks written for different releases.",
    fix: "Upgrade everything to the highest version the finding names; the upgrade runs each release's migration steps.",
    docs: "/docs/troubleshooting#mixed-versions",
  },
  "NF-D003": {
    why: "bun.lock records dependencies a file: package no longer declares. Bun never reads that package.json again, so it installs the recorded versions beside the declared ones.",
    fix: "Run `bun update <package>` for each package the finding names; `nifra upgrade --write` drops the entries before the next install.",
    docs: "/docs/troubleshooting#stale-file-links",
  },
  "NF-A001": {
    why: "A route fails the assurance policy in the bundle `nifra assure` builds, or declares a response contract the runtime does not enforce.",
    fix: "Fix the route the finding names, or enforce its response contract.",
    docs: "/docs/verification",
  },
  "NF-H001": {
    why: "Hydration replay found a mismatch between the server-rendered HTML and the first client render.",
    fix: "Render the same markup on both sides: move values that differ (time, randomness, browser-only state) into an effect.",
    docs: "/docs/hydration",
  },
  "NF-H002": {
    why: "Hydration loaded more than one copy of a framework runtime, so components and hooks from different copies do not work together.",
    fix: "Deduplicate the framework install so one copy serves both server and client.",
    docs: "/docs/hydration",
  },
  "NF-H003": {
    why: "The client build is older than the route source, so hydration would replay an outdated bundle.",
    fix: "Rebuild the client before checking hydration.",
    docs: "/docs/hydration",
  },
  "NF-H004": {
    why: "The hydration probe never became interactive, so the page's client code did not finish hydrating.",
    fix: "Open the page and fix the client error that stops hydration.",
    docs: "/docs/hydration",
  },
  "NF-K001": {
    why: "The contract snapshot no longer matches the routes the backend serves, so a contract change has not been reviewed and locked.",
    fix: "Review the change and snapshot the contracts again.",
    command: "nifra contracts snapshot",
    docs: "/docs/contract",
  },
  "NF-S001": {
    why: "A gate's catch block swallows the error, so a failure inside an authorization check lets the request through.",
    fix: "Rethrow, or return an explicit denial from the catch block.",
    docs: "/docs/security",
  },
  "NF-S002": {
    why: "A secret-like value is compared with `===` or similar, which leaks how much of it matched through timing.",
    fix: "Check the lengths, then compare with a timing-safe comparison.",
    command: "nifra fix --code NF-S002",
    docs: "/docs/security",
  },
  "NF-S003": {
    why: "A value shaped like personal data or a credential is passed straight to a log call, so it lands in the logs.",
    fix: "Log a redacted form or an identifier instead.",
    docs: "/docs/security",
  },
  "NF-S004": {
    why: "A CORS origin predicate never looks at the origin it is given, so it allows every origin.",
    fix: "List the allowed origins, or test the origin argument.",
    docs: "/docs/security",
  },
  "NF-S005": {
    why: "A redirect opts out of the same-origin default, so a target derived from request input becomes an open redirect.",
    fix: "Make sure the target can never come from request input, then mark it with `// nifra-expect NF-S005: <reason>`.",
    docs: "/docs/security",
  },
  "NF-S006": {
    why: "A security option is switched to its unsafe setting; the finding names the option and what it gives up.",
    fix: "Turn the option back on, or mark the reviewed choice with `// nifra-expect NF-S006: <reason>`.",
    docs: "/docs/security",
  },
  "NF-S007": {
    why: "A Secure cookie has no __Host- or __Secure- prefix, so a subdomain or an insecure page can set a cookie with the same name that shadows it.",
    fix: "Give the cookie a __Host- prefix (or __Secure- when it must reach subdomains).",
    docs: "/docs/security",
  },
  "NF-S008": {
    why: "An authenticated route validates its input before it authenticates, so an unauthenticated caller reaches the body parser and reads the validation issues.",
    fix: 'Authenticate with app.authenticate(), which runs before validation, or set `validationOrder: "auth-before-validation"` on the route.',
    docs: "/docs/auth",
  },
})
