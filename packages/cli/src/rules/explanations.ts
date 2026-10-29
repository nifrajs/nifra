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
    fix: "Return a plain object (set status, headers and cookies on c.set), use app.sse() for a stream, `bytes()` from @nifrajs/core/binary for a file or other binary body, or `raw<T>(response)` from the same module for a hand-built JSON Response; or declare `{ response: t.... }`. Mark an intended redirect with `// nifra-expect NF-C007: <reason>`.",
    docs: "/docs/api",
  },
  "NF-C008": {
    why: "Source imports a package package.json does not declare. It resolves today only through a hoisted or global install, and a clean install will not have it.",
    fix: "Declare it with `bun add <package>`.",
    docs: "/docs/troubleshooting",
  },
  "NF-C009": {
    why: "A package resolves to more than one physical copy of one version, so module-level state (contexts, registries, instanceof checks) splits between them. Copies at different versions are NF-C046.",
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
  "NF-C022": {
    why: "A bindList key reads the item's position (a second parameter, which bindList never passes, or an indexOf/findIndex call handed the item), so adding, removing or reordering items hands a node and its state to the wrong item.",
    fix: "Key each item by a stable id on the item.",
    docs: "/docs/islands",
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
    fix: 'Import through the boundary\'s public entry, or move the code to the zone that may use it. A frontend module backend code needs can be declared shared where it lives (a .shared suffix, or a "nifra.zones" shared entry) when its own imports are shared-safe; the finding says whether they are.',
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
    why: "backend/framework.ts sets no apiPrefix, so the backend is reachable from loaders only and a browser call to /api reaches page routing; or an app module's own createWebApp call mounts the backend at another apiPrefix than `nifra dev` serves it at.",
    fix: 'Export `apiPrefix = "/api"` to serve it over HTTP, or `apiPrefix = ""` to keep it loader-only. At a createWebApp call, import `apiPrefix` from backend/framework.ts, or, when another server already serves the backend there, mark the call `// nifra-expect NF-C035: <reason>`.',
    command: "nifra fix --code NF-C035",
    docs: "/docs/backends",
  },
  "NF-C036": {
    why: "A route's path is computed in a way the static scan cannot read, so the route lints do not see that route, and capability provenance finds its module only from the app `nifra.assurance.ts` loads.",
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
  "NF-C043": {
    why: "A merged route keeps the hooks of the server that declared it, so the authenticate() or auth plugin applied on this server before merge() never runs for it, and the merged server authenticates none of its routes.",
    fix: "Apply the auth plugin on the merged server, or declare its routes in a group() of this server. A module that is public on purpose takes `// nifra-expect NF-C043: <reason>` on the merge line.",
    docs: "/docs/plugins",
  },
  "NF-C044": {
    why: "A production client build moves the app's copy tables into one chunk per locale, and a page loads its locale's chunk from the `copyChunks` its server lists. A createWebApp call with a clientEntry and no copyChunks lists none, so the first page that renders copy fails in production, while `nifra dev`, which never splits, passes.",
    fix: 'Pass the client build\'s `copyChunks` to createWebApp: the generated server manifest exports it (`import { copyChunks } from "./server-manifest"`), and `buildClient()` returns it. A server that never serves those pages takes `// nifra-expect NF-C044: <reason>` on the call.',
    docs: "/docs/i18n",
  },
  "NF-C045": {
    why: "A route registration returns a new type that records the route. Called as a statement of its own, the route runs, but the exported server's type never includes it, so the typed client has no such call.",
    fix: "Chain the registration onto the server's declaration, or declare the routes on their own server() and merge() it. A route kept off the type on purpose takes `// nifra-expect NF-C045: <reason>` above the statement.",
    docs: "/docs/api#typed-client",
  },
  "NF-C046": {
    why: "A package resolves to copies at more than one version, often one in a linked sibling repository that installs its own. Module state splits as with NF-C009, and the two halves can also disagree on behavior. A singleCopy declaration only collapses copies of one version, so it cannot cover this.",
    fix: "Install one version everywhere: align the ranges in every install root that carries a copy, or for nifra packages run `nifra upgrade <version>` in this app and in the linked repository, then install in each.",
    docs: "/docs/troubleshooting",
  },
  "NF-C047": {
    why: 'A data-bind-* attribute inside an island host names a signal its bindIsland setup never declares with state("..."), or a handler the setup does not return. At runtime the binding is skipped with a console warning, so the markup never updates or never reacts.',
    fix: 'Fix the name in the markup, or declare it in the setup: state("name", initial) for a signal, a returned handler for data-bind-on.',
    docs: "/docs/islands",
  },
  "NF-C048": {
    why: "A data-bind-* attribute sits outside every data-island host, or inside a host mounted with defineIsland or a plain enhancer. Only bindIsland walks bindings, so this one never binds.",
    fix: "Move the element inside a host mounted with bindIsland, or mount that host with bindIsland. A binding inside a data-swap-slot belongs to an island inside that slot, which a swap mounts again.",
    docs: "/docs/islands",
  },
  "NF-C049": {
    why: "A data-swap attribute sits on an element other than <a href> or <form>, its value is not replace:<slot> or append:<slot>, or it is in JSX, where no page can answer a slot swap. The link or form behaves as if the attribute were not there.",
    fix: "Put data-swap on a link with an href or on a form, write replace:<slot> or append:<slot>, and render the page with @nifrajs/web-vanilla.",
    docs: "/docs/islands",
  },
  "NF-C050": {
    why: "A data-swap link or form names a slot that no data-swap-slot element in the project declares, so there is nothing to swap and every click loads the page normally.",
    fix: 'Fix the slot name, or mark the region to refresh with data-swap-slot="<name>" and render its content with slot("<name>", ...).',
    docs: "/docs/islands",
  },
  "NF-C051": {
    why: 'A data-swap-slot element must hold slot("<name>", ...) and nothing else: the server answers a swap with what slot() renders and the client replaces the whole element content with it. Content beside it is lost on the first swap; without it, the server has nothing to answer with; a slot() outside its element swaps nothing.',
    fix: 'Make slot("<name>", content) the only content of the element marked data-swap-slot="<name>", and move anything else outside it.',
    docs: "/docs/islands",
  },
  "NF-C052": {
    why: "A data-swap link or form goes to a page whose module and layouts render no slot() of the name it swaps, so the server answers with the whole document and every swap loads the page normally.",
    fix: "Point the link or form at the page that renders the slot, or render the slot in that page.",
    docs: "/docs/islands",
  },
  "NF-C053": {
    why: "A page whose backend half exports shellLoader calls getContext() or tryGetContext(). Its shell is built once and served to every visitor, so the shell check refuses a page that reads the request.",
    fix: "Read the request in a dynamic hole's loader, and render what uses it in that hole. The fix moves a read held in one const, and the one element that uses it, into a new hole.",
    command: "nifra fix --code NF-C053",
    docs: "/docs/partial-prerendering",
  },
  "NF-C054": {
    why: "The project builds an OpenAPI document from its running routes (openapi(), buildOpenApiDocument or toOpenAPI), and a route declares no response schema. The document can only say it answers 200, so a client generated from it, in any language, has no type for the body. nifra's typed client is unaffected: it reads the handler's TypeScript type.",
    fix: "Declare `{ response: ... }` on the route, or build the document with `nifra openapi`, which reads each handler's return type. A route kept out on purpose takes `// nifra-expect NF-C054: <reason>` above the registration.",
    docs: "/docs/api",
  },
  "NF-C055": {
    why: "zod's `z.coerce.boolean()` is `Boolean(value)`. A query, header or cookie value always arrives as text, so every non-empty value reads as true: `?archived=false` and `?archived=0` both do.",
    fix: "Use `z.stringbool()`, which reads `true`/`1`/`yes`/`on` as true, `false`/`0`/`no`/`off` as false, and refuses other text. A use kept on purpose takes `// nifra-expect NF-C055: <reason>` above the call.",
    docs: "/docs/api",
  },
  "NF-C056": {
    why: "The client build calls the namespace named by a `*.fn.ts` file (`todos.fn.ts` posts under `todos`). A `serverFunctions` mount under another word serves routes the stubs never reach, so every call 404s.",
    fix: 'Pass the filename\'s namespace to `serverFunctions` (`serverFunctions("todos", todos)` for `todos.fn.ts`), or rename the file. A mount kept on purpose takes `// nifra-expect NF-C056: <reason>` above the call.',
    docs: "/docs/server-functions",
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
    why: "bun.lock records dependencies a file: package no longer declares. Bun 1.4.2 never reads that package.json again, so it installs the recorded versions beside the declared ones.",
    fix: "Run `bun update <package>` for each package the finding names: it refreshes those entries and keeps every other pin. Deleting an entry by hand makes the next install re-resolve the whole lock.",
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
  "NF-S009": {
    why: "An app.ws() route parses frames itself in message() with no messageSchema, so a client's frame reaches the handler unvalidated and the typed client's send() is untyped.",
    fix: "Declare messageSchema (a discriminated union for several frame kinds): message() receives the parsed, validated value and invalid frames go to onInvalidMessage.",
    docs: "/docs/websockets",
  },
})
