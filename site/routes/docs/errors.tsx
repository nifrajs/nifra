import { catalogFixPrompts } from "@nifrajs/web/diagnostic-prompt"
import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

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
        without one (NF-C030).
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
        <code>window</code> or <code>localStorage</code>, invalid HTML nesting. <code>nifra_hydrate</code>{" "}
        reproduces it with a stable diagnostic. See <a href="/docs/hydration">hydration</a>.
      </p>
      <FixPrompts code="NIFRA_HYDRATION_MISMATCH" />

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
    </div>
  )
}
