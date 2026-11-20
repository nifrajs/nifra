import { catalogFixPrompts } from "@nifrajs/web/diagnostic-prompt"
import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"
import { href } from "@nifrajs/web-react/router"

export const meta = docsMeta(
  "/docs/errors",
  "Nifra - Error codes",
  "Every error code Nifra recognises: what each one means and how to fix it. The dev overlay, nifra_explain and nifra_errors name these codes and link here.",
)

const DIAGNOSTIC = `{
  "code": "NIFRA_OUTPUT_SENSITIVE_FIELD",
  "name": "OutputGuardError",
  "message": "OutputGuardError: loaderOutput declares passwordHash",
  "frames": [{ "file": "/app/routes/users/[id].backend.ts", "line": 9, "column": 3 }],
  "cause": "An output schema declares a field whose name marks it as a credential ...",
  "fix": "Remove the field from loaderOutput/actionOutput ...",
  "docsAnchor": "errors#output-sensitive-field"
}`

/** The catalog's paste-ready prompts for `code`, one per way to fix it. */
function FixPrompts({ code }: { code: string }) {
  const prompts = catalogFixPrompts(code)
  if (prompts.length === 0) return null
  return (
    <details className="fix-prompts">
      <summary>Prompt for your coding agent</summary>
      {prompts.map((p) => (
        <div key={p.label}>
          {prompts.length > 1 ? (
            <p>
              <strong>{p.label}</strong>
            </p>
          ) : null}
          <pre className="code">
            <code className="language-prompt">{p.prompt}</code>
          </pre>
        </div>
      ))}
    </details>
  )
}

export default function Errors() {
  return (
    <div className="prose">
      <h1 className="page">Error codes</h1>
      <p className="lead">
        When Nifra recognises a failure it gives it a stable code, says why it happened, and says what to
        do. The dev overlay shows it, <code>nifra_explain</code> returns it, and every entry{" "}
        <code>nifra_errors</code> reads from the running dev server carries it. A failure Nifra does not
        recognise is <code>NIFRA_UNHANDLED</code>, still with its frames and a codeframe around the line
        in your source.
      </p>
      <CodeBlock code={DIAGNOSTIC} lang="json" />
      <p>
        Each code below comes with a prompt to paste into a coding agent: the cause, one fix, and steps
        that end in a check the agent runs itself. For a failure in hand, the dev overlay and the issues
        badge on a dev page offer the same prompt filled in with its message, codeframe and request, and{" "}
        <code>nifra errors --prompt</code> prints it for the newest entry (<code>--id</code> picks one,{" "}
        <code>--option</code> picks a fix by its label). The prompt fences everything the running app
        supplied and names files relative to the project.
      </p>

      <h2>Code that crossed into the browser</h2>

      <h3 id="backend-in-client">NIFRA_BACKEND_IN_CLIENT</h3>
      <p>
        Browser code imported a module that stays on the server: something under{" "}
        <code>backend/</code>, a route's <code>x.backend.ts</code>, a server package, or a module
        outside every zone.
      </p>
      <p>
        <strong>Fix:</strong> reach backend code through the route's <code>x.backend.ts</code> (loader or
        action) or a <code>*.fn.ts</code> server function, and put code both sides need in{" "}
        <code>shared/</code>. The message names the import chain that pulled it in.
      </p>
      <FixPrompts code="NIFRA_BACKEND_IN_CLIENT" />

      <h3 id="backend-only-in-client">NIFRA_BACKEND_ONLY_IN_CLIENT</h3>
      <p>
        A module that imports the <code>@nifrajs/web/backend-only</code> marker was reachable from a
        client entry, so it would ship to the browser.
      </p>
      <p>
        <strong>Fix:</strong> follow the import chain in the message and move the module under{" "}
        <code>backend/</code>, reached from the route's <code>x.backend.ts</code> or a{" "}
        <code>*.fn.ts</code> server function.
      </p>
      <FixPrompts code="NIFRA_BACKEND_ONLY_IN_CLIENT" />

      <h3 id="node-builtin-in-client">NIFRA_NODE_BUILTIN_IN_CLIENT</h3>
      <p>
        A <code>node:</code> built-in was reached from a client entry. It has no browser implementation.
      </p>
      <p>
        <strong>Fix:</strong> move the code that uses it under <code>backend/</code> or into the route's{" "}
        <code>x.backend.ts</code>. The message lists the import chain.
      </p>
      <FixPrompts code="NIFRA_NODE_BUILTIN_IN_CLIENT" />

      <h2>Data the output guard refused</h2>
      <p>
        Loaders and actions declare the shape the page receives in <code>loaderOutput</code> and{" "}
        <code>actionOutput</code>. The output guard projects what they return onto that shape before it
        reaches the browser, and refuses what does not fit.
      </p>

      <h3 id="output-sensitive-field">NIFRA_OUTPUT_SENSITIVE_FIELD</h3>
      <p>
        An output schema declares a field whose name marks it as a credential (password, token, secret
        and the like), so the route refuses to send it to the browser.
      </p>
      <p>
        <strong>Fix:</strong> remove the field from <code>loaderOutput</code>/<code>actionOutput</code>.
        If it truly must reach the browser, wrap it in <code>t.declassified(reason, schema)</code>.{" "}
        <code>nifra check</code> reports the same as NF-C031.
      </p>
      <FixPrompts code="NIFRA_OUTPUT_SENSITIVE_FIELD" />

      <h3 id="output-undeclared-deferred">NIFRA_OUTPUT_UNDECLARED_DEFERRED</h3>
      <p>The loader returns a deferred (streamed) value its output schema does not declare.</p>
      <p>
        <strong>Fix:</strong> declare the field with <code>t.deferred(schema)</code> in{" "}
        <code>loaderOutput</code>, or stop deferring it.
      </p>
      <FixPrompts code="NIFRA_OUTPUT_UNDECLARED_DEFERRED" />

      <h3 id="output-raw-response">NIFRA_OUTPUT_RAW_RESPONSE</h3>
      <p>
        A loader or action returned a successful <code>Response</code>. Its body would reach the browser
        without passing the output schema.
      </p>
      <p>
        <strong>Fix:</strong> return the data itself so the schema projects it, or serve the raw response
        from a <code>backend/app.ts</code> route.
      </p>
      <FixPrompts code="NIFRA_OUTPUT_RAW_RESPONSE" />

      <h3 id="output-schema-mismatch">NIFRA_OUTPUT_SCHEMA_MISMATCH</h3>
      <p>
        Data a loader or action returned does not match its declared output schema, so it was refused
        before rendering.
      </p>
      <p>
        <strong>Fix:</strong> make the returned value match <code>loaderOutput</code>/
        <code>actionOutput</code> at the listed paths, or update the schema if the shape changed on
        purpose.
      </p>
      <FixPrompts code="NIFRA_OUTPUT_SCHEMA_MISMATCH" />

      <h3 id="output-guard">NIFRA_OUTPUT_GUARD</h3>
      <p>Route data failed the output guard that stands between loaders/actions and the browser.</p>
      <p>
        <strong>Fix:</strong> declare <code>loaderOutput</code>/<code>actionOutput</code> as a Standard
        Schema that describes exactly the fields the page needs. <code>nifra check</code> flags routes
        without one (NF-C030): an error when the loader's own body returns a literal (an object,
        array, string, number or boolean), since every request that reaches that return fails, and a
        warning when only running it shows what it returns. <code>nifra schemas --write</code> drafts
        a schema from the loader's return type for review, and{" "}
        <code>nifra fix --code NF-C030</code> writes that draft for each flagged route.
      </p>
      <FixPrompts code="NIFRA_OUTPUT_GUARD" />

      <h2>Rendering and data</h2>

      <h3 id="hydration-mismatch">NIFRA_HYDRATION_MISMATCH</h3>
      <p>
        The browser rendered different markup than the server sent, so the framework discarded or
        patched the server HTML. In development the page reports it to the dev server as a{" "}
        <code>hydration</code> entry, tagged with the request that rendered the page.
      </p>
      <p>
        <strong>Fix:</strong> look for values that differ between server and browser during render:{" "}
        <code>Date.now()</code>, <code>Math.random()</code>, locale formatting, reads of{" "}
        <code>window</code> or <code>localStorage</code>, invalid HTML nesting. With happy-dom
        installed in the project, <code>nifra_hydrate</code> reproduces it with a stable diagnostic.
        See <a href={href({ to: "/docs/hydration" })}>hydration</a>.
      </p>
      <FixPrompts code="NIFRA_HYDRATION_MISMATCH" />

      <h2>Server components</h2>

      <h3 id="component-request">NIFRA_COMPONENT_REQUEST</h3>
      <p>
        A server component request failed. The error carries a <code>code</code> and no further
        detail, so look on the server for the cause.
      </p>
      <ul>
        <li>
          <code>component_input</code> (422): the props the page sent failed the component's input
          schema.
        </li>
        <li>
          <code>component_denied</code> (403): the request was not same-origin (call components from
          your own pages), or the component's <code>authorize</code> callback refused it with a 401, 403
          or 404.
        </li>
        <li>
          <code>component_version</code> (409): the browser's build differs from the server's, usually
          after a deploy. Reload the page.
        </li>
        <li>
          <code>component_busy</code> (429): every render slot is busy and the waiting queue is full.
        </li>
        <li>
          <code>component_timeout</code> or <code>component_cancelled</code>: the component outran its
          deadline, or the request was aborted first.
        </li>
      </ul>
      <FixPrompts code="NIFRA_COMPONENT_REQUEST" />

      <h3 id="component-build">NIFRA_COMPONENT_BUILD</h3>
      <p>
        The server component build refused the project: a component module, a build entry, or the
        source graph breaks a rule the compiler relies on. The message names the rule.
      </p>
      <p>
        <strong>Fix:</strong> fix the one thing the message names and rebuild. The build never ships a
        bundle it refused.
      </p>
      <FixPrompts code="NIFRA_COMPONENT_BUILD" />

      <h2>Rendering and deployment</h2>

      <h3 id="ppr-contract">NIFRA_PPR_CONTRACT</h3>
      <p>
        A partially prerendered route broke the contract that lets its shell be shared between
        visitors: a visitor-specific loader, a dynamic hole set up wrongly, a nonce in the shell, or an
        invalid <code>ppr</code> option.
      </p>
      <p>
        <strong>Fix:</strong> keep per-visitor data out of the shell (move it into a dynamic boundary,
        or mark a layout loader <code>gate</code>), give every hole a <code>boundaryLoaders</code>{" "}
        entry, and use <code>csp: createCspPolicy(...)</code> instead of a per-request nonce.
      </p>
      <FixPrompts code="NIFRA_PPR_CONTRACT" />

      <h3 id="deployment-output">NIFRA_DEPLOYMENT_OUTPUT</h3>
      <p>
        A deployment adapter or the build output it was given broke a deployment rule: an unsafe or
        oversized output tree, a path collision, or an adapter that does not implement the interface
        this Nifra build supports.
      </p>
      <p>
        <strong>Fix:</strong> emit additions only through the returned <code>files</code> array, keep
        paths relative and distinct, and match the adapter API version this Nifra build supports.
      </p>
      <FixPrompts code="NIFRA_DEPLOYMENT_OUTPUT" />

      <h3 id="client-build-no-graph">NIFRA_CLIENT_BUILD_NO_GRAPH</h3>
      <p>
        The client build's result had no metafile (or one without inputs or outputs), so Nifra cannot
        prove which modules reached the browser. It refuses to write the bundle rather than guess.
      </p>
      <p>
        <strong>Fix:</strong> build the client through Nifra's build, which keeps the bundler's
        metafile. A custom build step must request the metafile and pass it through.
      </p>
      <FixPrompts code="NIFRA_CLIENT_BUILD_NO_GRAPH" />

      <h3 id="route-slot-unavailable">NIFRA_ROUTE_SLOT_UNAVAILABLE</h3>
      <p>
        A route slot named a parent route, a slot name, or a target route that is not registered, so
        the slot cannot render.
      </p>
      <p>
        <strong>Fix:</strong> register the route the slot points at, and spell the slot name as the
        parent route declares it.
      </p>
      <FixPrompts code="NIFRA_ROUTE_SLOT_UNAVAILABLE" />

      <h2>Middleware, stores and sessions</h2>

      <h3 id="memory-store-in-production">NIFRA_MEMORY_STORE_IN_PRODUCTION</h3>
      <p>An in-memory store (rate-limit MemoryStore, MemoryIdempotencyStore, MemoryResponseCache, MemorySessionStore) was created in production. Each instance keeps its own copy, so limits, de-duplication, cached responses or sessions differ per instance and are lost on restart.</p>
      <ul>
        <li>Use a shared store: Give the middleware or session manager a store every instance reads and writes (Redis or another shared backend) instead of the Memory* default.</li>
        <li>Single instance only: Pass &#123; allowInProduction: true &#125; when exactly one instance serves traffic and losing state on restart is acceptable.</li>
      </ul>
      <FixPrompts code="NIFRA_MEMORY_STORE_IN_PRODUCTION" />

      <h3 id="cors-credentials-wildcard">NIFRA_CORS_CREDENTIALS_WILDCARD</h3>
      <p>cors() was given <code>credentials: true</code> with <code>origin: "*"</code>. Browsers refuse a wildcard origin on a credentialed request, so the combination can never work.</p>
      <p>
        <strong>Fix:</strong> List the explicit origin(s) that may send credentials instead of the wildcard.
      </p>
      <FixPrompts code="NIFRA_CORS_CREDENTIALS_WILDCARD" />

      <h3 id="secret-too-short">NIFRA_SECRET_TOO_SHORT</h3>
      <p>A signing secret is shorter than the 32 bytes (256 bits) nifra requires, so it is refused instead of used.</p>
      <p>
        <strong>Fix:</strong> Generate one with <code>openssl rand -base64 32</code> and load it from the environment.
      </p>
      <FixPrompts code="NIFRA_SECRET_TOO_SHORT" />

      <h3 id="middleware-order">NIFRA_MIDDLEWARE_ORDER</h3>
      <p>A middleware that protects routes was installed after the routes it should guard, so those routes were registered without it.</p>
      <p>
        <strong>Fix:</strong> Call app.use(...) for it before registering the routes it protects.
      </p>
      <FixPrompts code="NIFRA_MIDDLEWARE_ORDER" />

      <h3 id="context-storage-missing">NIFRA_CONTEXT_STORAGE_MISSING</h3>
      <p>getContext() ran outside a request that went through contextStorage(): the middleware was not installed before the route, or the code ran outside any request (a partially prerendered shell is built outside every request).</p>
      <p>
        <strong>Fix:</strong> Add app.use(contextStorage()) before the route and call getContext() during that request. For a PPR shell, read the request in a dynamic boundary's loader instead.
      </p>
      <FixPrompts code="NIFRA_CONTEXT_STORAGE_MISSING" />

      <h3 id="session-store-consistency">NIFRA_SESSION_STORE_CONSISTENCY</h3>
      <p>The session manager was given an eventually consistent store such as KVSessionStore. Logout and rotation need a read to see the write that revoked a session, which that kind of store does not promise.</p>
      <p>
        <strong>Fix:</strong> Use a strongly consistent shared SessionStore.
      </p>
      <FixPrompts code="NIFRA_SESSION_STORE_CONSISTENCY" />

      <h2>Routes, wire and data</h2>

      <h3 id="route-config">NIFRA_ROUTE_CONFIG</h3>
      <p>A route is misconfigured, and registration refuses it at boot rather than failing on the first request. The error's <code>code</code> names the rule (DUPLICATE_ROUTE, INVALID_PATH, INVALID_METHOD, WILDCARD_NOT_LAST, INVALID_IDEMPOTENCY, ...).</p>
      <p>
        <strong>Fix:</strong> Read the <code>code</code> and the message, then correct the route definition they name. The server does not start until the route is valid.
      </p>
      <FixPrompts code="NIFRA_ROUTE_CONFIG" />

      <h3 id="route-files">NIFRA_ROUTE_FILES</h3>
      <p>The file routes, or a route's exports, break a convention the router relies on: two files map to one URL, two <code>_404</code> files answer the same URLs, an optional segment is mixed with literal text, a layout exports an <code>action</code>, or a route turns off both server rendering and hydration.</p>
      <p>
        <strong>Fix:</strong> The message names the files and the rule. Keep one file per URL, one <code>_404</code> per scope, and put actions in route files, not layouts.
      </p>
      <FixPrompts code="NIFRA_ROUTE_FILES" />

      <h3 id="wire-invalid">NIFRA_WIRE_INVALID</h3>
      <p>A value could not be encoded or decoded on the typed wire: a malformed frame, an unsupported codec or content type, a payload over maxBytes, or a value that is not JSON serializable.</p>
      <p>
        <strong>Fix:</strong> Send values the wire can carry, from a client built against this server's contract. For an oversized payload, send less or raise maxBytes on purpose.
      </p>
      <FixPrompts code="NIFRA_WIRE_INVALID" />

      <h3 id="storage-key">NIFRA_STORAGE_KEY</h3>
      <p>A storage key was refused before any read or write: it is empty or over 1024 characters, is absolute, has a backslash, NUL, "..", or an empty or "." segment, escapes the storage root, or reaches the file through a symbolic link, a moved root directory or an untrusted writable directory.</p>
      <p>
        <strong>Fix:</strong> Build keys as relative, forward-slash paths that stay under the storage root, and never put unchecked user input into a key. For a symbolic link, a moved root or an untrusted directory, the message names what to check on the filesystem.
      </p>
      <FixPrompts code="NIFRA_STORAGE_KEY" />

      <h3 id="storage-read-limit">NIFRA_STORAGE_READ_LIMIT</h3>
      <p>An R2 object is larger than maxReadBytes (or reports invalid size metadata), so R2Storage refuses to buffer it. The key itself was valid.</p>
      <p>
        <strong>Fix:</strong> Raise maxReadBytes on the R2Storage if objects of that size are expected; otherwise find why the object is larger than the limit.
      </p>
      <FixPrompts code="NIFRA_STORAGE_READ_LIMIT" />

      <h3 id="openapi-import">NIFRA_OPENAPI_IMPORT</h3>
      <p>The OpenAPI document cannot be imported: it is malformed, uses a version outside 3.0.x, 3.1.x and 3.2.x, exceeds an import limit, or holds a construct Nifra cannot represent (a parameter $ref, an unsupported path template).</p>
      <p>
        <strong>Fix:</strong> The message names the path in the document. Fix that part, and inline parameter $refs before importing: refs are never resolved.
      </p>
      <FixPrompts code="NIFRA_OPENAPI_IMPORT" />

      <h3 id="schema-declaration">NIFRA_SCHEMA_DECLARATION</h3>
      <p>A schema declaration uses something the schema builder cannot accept: a file list nested in a list, a file field outside t.form(), a header name that is not lower-cased, a declassified field with no reason, or a feature precompile refuses (custom registry kinds, runtime-only metadata).</p>
      <p>
        <strong>Fix:</strong> The message names the declaration and what it expects. Declare file fields in t.form(), give declassified a reason, and keep precompiled schemas to plain, compilable shapes.
      </p>
      <FixPrompts code="NIFRA_SCHEMA_DECLARATION" />

      <h3 id="assurance-input">NIFRA_ASSURANCE_INPUT</h3>
      <p>An assurance, capability, manifest or evidence declaration is malformed: an id, path glob, scope, provenance, method or policy field outside what the registry accepts.</p>
      <p>
        <strong>Fix:</strong> The message names the field and the accepted form (lowercase dot/dash ids, absolute path globs, a known scope). Correct the declaration; <code>nifra check</code> reports the same project-wide.
      </p>
      <FixPrompts code="NIFRA_ASSURANCE_INPUT" />

      <h3 id="effect-invalid">NIFRA_EFFECT_INVALID</h3>
      <p>An effect, saga or durable-journal declaration, or the store behind it, broke its contract: a value out of range, a missing step, or a store that is not durable where durability is required.</p>
      <p>
        <strong>Fix:</strong> The message names the part. Where it says <code>store.durability === "durable"</code>, back the journal with a durable store; otherwise correct the id, cost or limit it names.
      </p>
      <FixPrompts code="NIFRA_EFFECT_INVALID" />

      <h3 id="content-invalid">NIFRA_CONTENT_INVALID</h3>
      <p>A content collection, its baked index, or an MDX extension is malformed or out of range.</p>
      <p>
        <strong>Fix:</strong> The message names the index, bucket or extension. Correct the collection definition it names.
      </p>
      <FixPrompts code="NIFRA_CONTENT_INVALID" />

      <h3 id="jobs-invalid">NIFRA_JOBS_INVALID</h3>
      <p>A job, its payload, or a dead-letter record cannot be stored as data: a duplicate job name, an Error instance, a custom prototype, an accessor, or a record the dead-letter view cannot read.</p>
      <p>
        <strong>Fix:</strong> Make the payload plain data (objects, arrays, strings, numbers, booleans), and give each job one name.
      </p>
      <FixPrompts code="NIFRA_JOBS_INVALID" />

      <h3 id="i18n-config">NIFRA_I18N_CONFIG</h3>
      <p>The locale, copy-table or localized-path configuration breaks a rule: a duplicate id or canonical pathname, two locales sharing an hreflang, a draft default locale, or a copy value of the wrong kind.</p>
      <p>
        <strong>Fix:</strong> The message names the locale, table or pathname. Make the ids and pathnames unique and give each locale its own hreflang.
      </p>
      <FixPrompts code="NIFRA_I18N_CONFIG" />

      <h2>Build and assets</h2>

      <h3 id="build-plugin">NIFRA_BUILD_PLUGIN</h3>
      <p>A build plugin (CSS Modules, SCSS, StyleX, a Vue single-file component, Svelte MDX) failed on a file or is missing a compiler dependency.</p>
      <p>
        <strong>Fix:</strong> The message names the file and the compiler's own reason. Fix that source, or install the compiler package it says is missing or incompatible.
      </p>
      <FixPrompts code="NIFRA_BUILD_PLUGIN" />

      <h3 id="build-output">NIFRA_BUILD_OUTPUT</h3>
      <p>The client or server build, or the directory it writes to, broke a rule: no entry-point output, an output or public directory that is a symlink, escapes its root or overlaps the other, a build target the chosen option does not fit, or a glob pattern the bundler cannot read.</p>
      <p>
        <strong>Fix:</strong> The message names the path, target or option. Move the output or public directory, drop the option the target does not support, or give the bundler a literal pattern.
      </p>
      <FixPrompts code="NIFRA_BUILD_OUTPUT" />

      <h3 id="asset-invalid">NIFRA_ASSET_INVALID</h3>
      <p>A font, web manifest or service-worker asset was refused: a download from a non-allowed host or over its size limit, a stylesheet with no usable font files, an unknown manifest value, or a path with characters an asset path cannot hold.</p>
      <p>
        <strong>Fix:</strong> The message names the family, URL or field. Request only Google-hosted fonts within the limits, and use the manifest values and path characters it lists.
      </p>
      <FixPrompts code="NIFRA_ASSET_INVALID" />

      <h2>Framework warnings</h2>

      <h3 id="vue-warning">NIFRA_VUE_WARNING</h3>
      <p>Vue's development build warned about a component. The text after <code>[Vue warn]:</code> names the problem, and Vue's component trace names the component it happened in.</p>
      <p>
        <strong>Fix:</strong> Fix the component the trace names. Do not silence Vue's warn handler: each warning is raised for a real mistake in that component.
      </p>
      <FixPrompts code="NIFRA_VUE_WARNING" />

      <h3 id="svelte-diagnostic">NIFRA_SVELTE_DIAGNOSTIC</h3>
      <p>Svelte's development build reported a mistake. The identifier after <code>[svelte]</code> (or at the end of the https://svelte.dev/e/ link) is Svelte's own stable code.</p>
      <p>
        <strong>Fix:</strong> Open https://svelte.dev/e/&lt;code&gt; for the cause and the repair, then fix the component the message locates.
      </p>
      <FixPrompts code="NIFRA_SVELTE_DIAGNOSTIC" />

      <h3 id="react-warning">NIFRA_REACT_WARNING</h3>
      <p>React reported a mistake: a development warning that links to react.dev/link/..., or an error whose message links to react.dev/errors/... (a minified production error).</p>
      <p>
        <strong>Fix:</strong> Open the link in the message for the cause and the repair, then fix the component React's trace names. A react.dev/errors message is a thrown error, not a warning.
      </p>
      <FixPrompts code="NIFRA_REACT_WARNING" />

      <h2>More framework warnings</h2>

      <h3 id="preact-diagnostic">NIFRA_PREACT_DIAGNOSTIC</h3>
      <p>Preact's debug build reported a mistake in a component: invalid nesting, a duplicate key, an invalid element type, a hook outside render, a render loop, or a prop of the wrong type. Preact has no stable code, so the message text is the identifier.</p>
      <p>
        <strong>Fix:</strong> Fix the component the message names; Preact appends its component stack. Do not remove preact/debug to quiet it: each message is raised for a real mistake.
      </p>
      <FixPrompts code="NIFRA_PREACT_DIAGNOSTIC" />

      <h2>Configuration and runtime</h2>

      <h3 id="header-value-invalid">NIFRA_HEADER_VALUE_INVALID</h3>
      <p>A response header or cookie value was refused: a control character, a newline, a leading or trailing space, an illegal character in a cookie Domain or Path, a <code>__Host-</code> cookie with a Domain, a cookie over its size limit, or a framing header set statically.</p>
      <p>
        <strong>Fix:</strong> The message names the header or cookie. Remove the character it names, and set per-response headers with c.set.headers (cookies with c.set.cookie) instead of statically.
      </p>
      <FixPrompts code="NIFRA_HEADER_VALUE_INVALID" />

      <h3 id="csp-config">NIFRA_CSP_CONFIG</h3>
      <p>The Content-Security-Policy or inline-script setup conflicts: a cspHeader and a nonce resolver both writing the header, an executable inline script without a nonce, content the inert head.script slot refuses, or a policy used before it was prepared.</p>
      <p>
        <strong>Fix:</strong> The message names the conflict. Use either <code>nonce</code> or <code>csp: createCspPolicy(...)</code>, give executable scripts a non-empty nonce, and use unsafeInlineScript() only where the message says to.
      </p>
      <FixPrompts code="NIFRA_CSP_CONFIG" />

      <h3 id="cdn-config">NIFRA_CDN_CONFIG</h3>
      <p>A CDN adapter was given a missing binding or a store that cannot do what was asked (for example invalidate by tag), or an option outside what it accepts.</p>
      <p>
        <strong>Fix:</strong> The message names the adapter and what to pass (the <code>cache</code> binding, the @vercel/functions helper, a store that supports tags). Pass it where the CDN is configured.
      </p>
      <FixPrompts code="NIFRA_CDN_CONFIG" />

      <h3 id="parity-failed">NIFRA_PARITY_FAILED</h3>
      <p>The development/production parity check failed (identity parity or manifest parity), or its scan hit the limit before it could decide.</p>
      <p>
        <strong>Fix:</strong> Read the differences the message lists and make development and production agree. When the scan limit was reached, narrow the scan by running from the app or workspace root.
      </p>
      <FixPrompts code="NIFRA_PARITY_FAILED" />

      <h3 id="api-misuse">NIFRA_API_MISUSE</h3>
      <p>An API was called in a state it does not allow: next() called twice, a request body read as a stream after it was consumed, a response body sent twice, headers written after the response was committed, notFound() applied twice or inside a group, or a query used with no query client.</p>
      <p>
        <strong>Fix:</strong> The message names the call. Call it once, before the response is committed, and on the object it belongs to (read bodies with c.req.bytes() in a hook; apply notFound() to the parent server).
      </p>
      <FixPrompts code="NIFRA_API_MISUSE" />

      <h3 id="websocket-invalid">NIFRA_WEBSOCKET_INVALID</h3>
      <p>A WebSocket was opened or closed in a way the protocol or the client does not allow: a close reason over 123 UTF-8 bytes, a close code a server may not send, a path with a dot segment, or an in-process client that has no socket.</p>
      <p>
        <strong>Fix:</strong> Close with a reason of at most 123 bytes and a code in 1000-1003, 1007-1014 or 3000-4999. Open sockets against a listening app, at a path without <code>.</code> or <code>..</code> segments.
      </p>
      <FixPrompts code="NIFRA_WEBSOCKET_INVALID" />

      <h3 id="value-not-serializable">NIFRA_VALUE_NOT_SERIALIZABLE</h3>
      <p>A value could not be turned into JSON or the typed wire: a circular reference, a BigInt, a non-finite number, a class instance, an undefined field or array item, or a type the wire has no encoding for.</p>
      <p>
        <strong>Fix:</strong> Send plain data: objects, arrays, strings, finite numbers and booleans. Convert BigInt and class instances to plain values before they cross the boundary.
      </p>
      <FixPrompts code="NIFRA_VALUE_NOT_SERIALIZABLE" />

      <h3 id="cron-invalid">NIFRA_CRON_INVALID</h3>
      <p>A cron schedule or job registration is invalid: not five space-separated fields, an empty, out-of-range or malformed term, or two jobs with the same name.</p>
      <p>
        <strong>Fix:</strong> Write the schedule as five space-separated fields with each value in its range, and register each job name once.
      </p>
      <FixPrompts code="NIFRA_CRON_INVALID" />

      <h3 id="graphql-request">NIFRA_GRAPHQL_REQUEST</h3>
      <p>A GraphQL request was malformed (no <code>query</code>, a body that is not a JSON object, variables that are not a JSON object), or mountGraphql was configured in a way it refuses.</p>
      <p>
        <strong>Fix:</strong> For a request, send a JSON object with a <code>query</code> string and an object for <code>variables</code>. For mountGraphql, call <code>.use(websocket())</code> before enabling subscriptions, and guard sockets with the same authorization as the HTTP endpoint.
      </p>
      <FixPrompts code="NIFRA_GRAPHQL_REQUEST" />

      <h3 id="image-invalid">NIFRA_IMAGE_INVALID</h3>
      <p>An image could not be processed or generated: a source that failed to decode or changed while it was being opened, variants without positive dimensions, or generated output over its size limit.</p>
      <p>
        <strong>Fix:</strong> The message names the step. Give the image a valid source and positive dimensions, and keep generated output within maxBytes.
      </p>
      <FixPrompts code="NIFRA_IMAGE_INVALID" />

      <h3 id="http-response-invalid">NIFRA_HTTP_RESPONSE_INVALID</h3>
      <p>The server adapter could not write or read the HTTP message: a status code outside the valid range, a body whose length disagrees with its Content-Length, an invalid header character, or a request that closed early.</p>
      <p>
        <strong>Fix:</strong> Return a valid status, send a body that matches the Content-Length you set (or omit it), and keep header names and values to legal characters.
      </p>
      <FixPrompts code="NIFRA_HTTP_RESPONSE_INVALID" />

      <h3 id="option-renamed">NIFRA_OPTION_RENAMED</h3>
      <p>An option was renamed in this version, and the old name is no longer read.</p>
      <p>
        <strong>Fix:</strong> The message gives the new name. Rename the option where you pass it.
      </p>
      <FixPrompts code="NIFRA_OPTION_RENAMED" />

      <h3 id="client-refused">NIFRA_CLIENT_REFUSED</h3>
      <p>The typed client refused a response or a request: a response that breaks the route's declared contract, a server-sent event over its size limit, or a form field that is neither text nor a file.</p>
      <p>
        <strong>Fix:</strong> For a contract violation, make the server return what its route declares (or update the declaration). For a form body, send strings and files only.
      </p>
      <FixPrompts code="NIFRA_CLIENT_REFUSED" />

      <h3 id="tool-invalid">NIFRA_TOOL_INVALID</h3>
      <p>A tool declaration, its adapter, or its approval or budget settings break a rule: an option of the wrong type, a limit exceeded, a missing approval, or a duplicate tool name.</p>
      <p>
        <strong>Fix:</strong> The message names the tool and the field. Correct the declaration; <code>nifra check</code> reports the same project-wide.
      </p>
      <FixPrompts code="NIFRA_TOOL_INVALID" />

      <h3 id="jwks-unavailable">NIFRA_JWKS_UNAVAILABLE</h3>
      <p>The JWKS endpoint used to verify tokens could not be used: the fetch failed, the response could not be read or was over its size limit, the key set was invalid, or the URL is not https.</p>
      <p>
        <strong>Fix:</strong> The message gives the status or reason. Check that the JWKS URL is reachable over https (localhost is allowed) and returns a valid key set within maxBytes.
      </p>
      <FixPrompts code="NIFRA_JWKS_UNAVAILABLE" />

      <h3 id="body-parser-refused">NIFRA_BODY_PARSER_REFUSED</h3>
      <p>bodyParser was given a media type nifra already handles (JSON, a form, multipart) or one a browser can send from any site without a preflight request.</p>
      <p>
        <strong>Fix:</strong> The message names the media type and what to do instead: body schemas already read JSON and forms, multipart uses multipartBody from @nifrajs/core/multipart, and a no-preflight type must be read in the handler.
      </p>
      <FixPrompts code="NIFRA_BODY_PARSER_REFUSED" />

      <h3 id="idempotency-store-corrupt">NIFRA_IDEMPOTENCY_STORE_CORRUPT</h3>
      <p>A stored idempotency record could not be replayed: its body or status is not in the form the middleware wrote.</p>
      <p>
        <strong>Fix:</strong> First confirm whether the original operation completed: deleting the record lets the next retry with that key run the handler again, which repeats any side effect already done (a charge, an email). Delete the record only once the operation is known not to have completed, or reconcile its effect by hand. If it recurs, check that nothing else writes to the idempotency store and that the store does not alter values.
      </p>
      <FixPrompts code="NIFRA_IDEMPOTENCY_STORE_CORRUPT" />

      <h3 id="authjs-request-failed">NIFRA_AUTHJS_REQUEST_FAILED</h3>
      <p>The Auth.js bridge called an Auth.js endpoint (sign in, sign out, CSRF token) and it failed or did not answer.</p>
      <p>
        <strong>Fix:</strong> The message gives the HTTP status. Check that the Auth.js endpoint is mounted and answering.
      </p>
      <FixPrompts code="NIFRA_AUTHJS_REQUEST_FAILED" />

      <h3 id="action-failed">NIFRA_ACTION_FAILED</h3>
      <p>A route action request answered with a non-OK status, so the router threw instead of returning a result.</p>
      <p>
        <strong>Fix:</strong> The message gives the status and the action URL. Look at the response and logs for that status on the server.
      </p>
      <FixPrompts code="NIFRA_ACTION_FAILED" />

      <h3 id="strict-mode">NIFRA_STRICT_MODE</h3>
      <p>A startup check failed while strict mode is on, so the process refuses to start instead of running with the problem.</p>
      <p>
        <strong>Fix:</strong> Fix the problems the message lists above that line. Strict mode is meant to turn them into a startup failure.
      </p>
      <FixPrompts code="NIFRA_STRICT_MODE" />

      <h3 id="library-resolution">NIFRA_LIBRARY_RESOLUTION</h3>
      <p>A UI library or optional peer did not resolve to one working copy: two copies of React reached server rendering (react-dom renders with a different React than your components import), or an optional peer is missing or failed to load.</p>
      <p>
        <strong>Fix:</strong> For two copies, dedupe the library in your package manager so react-dom and your components import the same React. For a peer, the message names it and the underlying error: install it, or use the default build.
      </p>
      <FixPrompts code="NIFRA_LIBRARY_RESOLUTION" />

      <h2>Configuration and runtime</h2>

      <h3 id="runtime-missing">NIFRA_RUNTIME_MISSING</h3>
      <p>A feature was used without its opt-in runtime installed: WebSocket routes, server-sent events, MCP declarations or the Node-direct renderer ship as separate plugins so apps that do not use them stay small.</p>
      <p>
        <strong>Fix:</strong> The message names the plugin. Add the <code>.use(...)</code> it shows (websocket() from @nifrajs/core/ws, the streaming runtime, mcp(), or nodeDirect() from @nifrajs/core/node-direct) before declaring the routes that need it, on the parent app when the routes are mounted from a child.
      </p>
      <FixPrompts code="NIFRA_RUNTIME_MISSING" />

      <h3 id="server-lifecycle">NIFRA_SERVER_LIFECYCLE</h3>
      <p>The server was configured at the wrong time or on the wrong runtime: a hook added after the page routes were declared (no page runs it), configuration changed after listen() sealed the server, or listen() called outside Bun.</p>
      <p>
        <strong>Fix:</strong> Move the call before listen(). For a late hook, apply it in createWebApp(&#123; use &#125;) to cover the pages, or inside app.group(prefix, ...). Off Bun, serve with @nifrajs/node or @nifrajs/deno, or hand app.fetch to a fetch-compatible runtime.
      </p>
      <FixPrompts code="NIFRA_SERVER_LIFECYCLE" />

      <h2>Options</h2>

      <h3 id="live-config">NIFRA_LIVE_CONFIG</h3>
      <p>
        The live (real-time) options are invalid: a missing or short secret, a hub and bus configured
        together, a path that is not absolute, or a subject that does not return a string.
      </p>
      <p>
        <strong>Fix:</strong> the message names the option. A secret must be at least 32 bytes (
        <code>openssl rand -base64 32</code>), and <code>hub</code> and <code>bus</code> are exclusive.
      </p>
      <FixPrompts code="NIFRA_LIVE_CONFIG" />

      <h3 id="option-invalid">NIFRA_OPTION_INVALID</h3>
      <p>
        An option passed to a Nifra function (<code>createWebApp</code>, a route, the CDN, ISR, a
        manifest) has a value outside what it accepts.
      </p>
      <p>
        <strong>Fix:</strong> the message names the option and the shape it accepts. Correct the value
        at the call that sets it; nothing is silently coerced.
      </p>
      <FixPrompts code="NIFRA_OPTION_INVALID" />

      <h3 id="solid-diagnostic">NIFRA_SOLID_DIAGNOSTIC</h3>
      <p>
        Solid 2.0's development build reported a reactivity mistake. The message opens with Solid's own
        stable code in square brackets (<code>[STRICT_READ_UNTRACKED]</code>), then names the owner path,
        the source location, and the guide for that code. Nifra records it in the dev feed so{" "}
        <code>nifra explain</code> and <code>nifra_explain</code> return it with the rest of your errors.
      </p>
      <p>
        <strong>Fix:</strong> open the repair guide the message names (
        <code>node_modules/solid-js/skills/reactivity-diagnostics/SKILL.md</code>, anchored by the
        lower-cased code) and apply its repair at the reported location. Do not silence the report:
        Solid raises each one for a real defect or a real cost.
      </p>
      <FixPrompts code="NIFRA_SOLID_DIAGNOSTIC" />

      <h3 id="schema-parse">NIFRA_SCHEMA_PARSE</h3>
      <p>Data crossing a boundary did not match its declared schema.</p>
      <p>
        <strong>Fix:</strong> check the value against the schema at the failing boundary (loader input,
        search params, or request body). Parse, don't cast: the shape must match exactly.
      </p>
      <FixPrompts code="NIFRA_SCHEMA_PARSE" />

      <h2>CDN caching</h2>

      <h3 id="cdn-host-routed">NIFRA_CDN_HOST_ROUTED</h3>
      <p>
        <code>cloudflareWorkersCache</code> was given <code>hostRouted: true</code>. Workers Cache keys
        pages by path, not by host, so a Worker that serves different content per hostname would serve
        one host's page to another.
      </p>
      <p>
        <strong>Fix:</strong> put a Cloudflare zone in front instead (<code>cloudflareZone</code>), or
        serve each hostname from its own Worker.
      </p>

      <FixPrompts code="NIFRA_CDN_HOST_ROUTED" />

      <h3 id="cdn-tag-invalid">NIFRA_CDN_TAG_INVALID</h3>
      <p>
        A route's <code>revalidateTags</code> function returned a tag outside the allowed form (a letter,
        then up to 127 of <code>A-Z a-z 0-9 . _ : / -</code>), more than 32 tags, or something other than
        an array. Those tags were dropped, so a purge by them reaches nothing. The warning names the
        route, never the tag.
      </p>
      <p>
        <strong>Fix:</strong> build tags from route params (<code>product:$&#123;params.id&#125;</code>),
        keep to the allowed characters, and return at most 32.
      </p>

      <FixPrompts code="NIFRA_CDN_TAG_INVALID" />

      <h3 id="cdn-rate-limited">NIFRA_CDN_RATE_LIMITED</h3>
      <p>
        The CDN's purge API answered 429. Cloudflare's Free plan allows 5 purge calls a minute, and
        Workers Cache always has Free-plan limits.
      </p>
      <p>
        <strong>Fix:</strong> nothing while the line says <em>retrying</em>: the queue waits out{" "}
        <code>Retry-After</code>. If purges keep hitting the limit, send several tags in one revalidate
        call or raise <code>debounceMs</code>.
      </p>

      <FixPrompts code="NIFRA_CDN_RATE_LIMITED" />

      <h3 id="cdn-purge-failed">NIFRA_CDN_PURGE_FAILED</h3>
      <p>
        The CDN refused a purge, or could not be reached. The origin store was purged; the CDN may keep
        serving the old page until its freshness runs out. The revalidate endpoint answers{" "}
        <code>502</code> with <code>retryable</code> in this case, never success.
      </p>
      <p>
        <strong>Fix:</strong> read the reason in the line. A 401 or 403 means the token lacks purge
        permission for this zone, project or service; a 5xx or <code>network_error</code> is retried on
        its own.
      </p>

      <FixPrompts code="NIFRA_CDN_PURGE_FAILED" />

      <h2>Keep-alive</h2>

      <h3 id="keepalive-identity-cookie">NIFRA_KEEPALIVE_IDENTITY_COOKIE</h3>
      <p>
        The app keeps pages alive, and a response changed or deleted an <code>HttpOnly</code> cookie
        Nifra does not know as a sign-in cookie. If that cookie says who is signed in, a sign-in or
        sign-out through it leaves the previous visitor's kept pages in every tab, and back shows
        them. Development reports each cookie name once.
      </p>
      <p>
        <strong>Fix:</strong> name the cookie in{" "}
        <code>createWebApp(&#123; keepAlive: &#123; identityCookies &#125; &#125;)</code> if it
        carries the session, or in <code>keepAlive.ignoreCookies</code> if it does not. When the
        session is a token in client storage, call <code>identityChanged()</code> from{" "}
        <code>@nifrajs/web/client</code> at sign-in and sign-out. See{" "}
        <a href={href({ to: "/docs/keep-alive", hash: "sign-in" })}>keep-alive and sign-in</a>.
      </p>

      <FixPrompts code="NIFRA_KEEPALIVE_IDENTITY_COOKIE" />

      <h3 id="keepalive-direct-child-css">NIFRA_KEEPALIVE_DIRECT_CHILD_CSS</h3>
      <p>
        A <code>keepAlive</code> page renders inside two <code>display:contents</code> wrappers, so a
        selector that reached its root element as a direct child of the layout (
        <code>main &gt; section</code>), by its position among siblings (<code>:first-child</code>,{" "}
        <code>:nth-child()</code>), or through <code>:has(&gt; ...)</code> on the layout no longer
        matches it. Development checks the page's same-origin stylesheets the first time it is shown
        and reports each selector once.
      </p>
      <p>
        <strong>Fix:</strong> use a descendant combinator (<code>main section</code>), target the
        wrapper (<code>[data-nifra-page] &gt; section</code>), or give the page's root element a class
        and select that.
      </p>

      <FixPrompts code="NIFRA_KEEPALIVE_DIRECT_CHILD_CSS" />

      <h2 id="nifra-expect">Silencing a nifra check finding</h2>
      <p>
        <code>nifra check</code> names each finding with an <code>NF-</code> code;{" "}
        <code>nifra explain NF-C007</code> (or <code>nifra_explain</code> with the code as its{" "}
        <code>error</code>) says what the rule reports, why it matters, how to fix it and where it is
        documented. Where a finding is reviewed and intended, a comment on the flagged line, or anywhere
        in the comment block directly above it, says so and why:
      </p>
      <CodeBlock
        code={
          "// nifra-expect NF-S002: compares the challenge the sender echoes back, not a secret\nif (echoToken === challenge) return accept()"
        }
      />
      <p>
        The comment answers only the code it names. A finding that fails the check, and every security
        finding, is silenced only with a reason after the colon; an advisory also accepts the comment
        without one. A blank line or a line of code ends the block, so a comment never reaches the next
        statement. A silenced security finding, interpolated SQL (NF-C006) included, stays in the report
        as information, with the comment and its reason as evidence. Some codes also answer to a name: <code>sql-dynamic</code> (NF-C006),{" "}
        <code>raw-response</code> (NF-C007), <code>reserved-segment</code> (NF-C018),{" "}
        <code>route-overlap</code> (NF-C024 and NF-C025) and <code>param-modifier</code> (NF-C026).{" "}
        <code>@nifra-gate-reviewed</code> silences nothing; a finding under it names the comment to
        write instead.
      </p>
      <p>
        A fail-open gate (NF-S001) or a non-constant-time comparison (NF-S002) in code that only
        ever runs in a browser is a warning rather than an error: the server's own gate decides
        there.
      </p>
    </div>
  )
}
