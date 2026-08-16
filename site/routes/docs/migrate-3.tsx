import { CodeBlock } from "../../highlight"
import { docsMeta } from "../../meta"

export const hydrate = false

export const meta = docsMeta(
  "/docs/migrate-3",
  "Nifra 3.0 migration guide - upgrade from 2.x",
  "Upgrade a Nifra 2.x application to 3.0: automated dependency pins, the plain-data redirect return value, the frozen reserved typed-client segment keys and their codemod, the Node proxy transport default, and the release gates.",
)

const COMMANDS = [
  "nifra upgrade 3.0.0                 # dry-run: inspect every planned edit",
  "nifra upgrade 3.0.0 --write         # apply edits, then run nifra check",
  "bun install",
  "bun run test",
  "bun run build",
].join("\n")

const REDIRECT = [
  "// 2.x - a redirect was a Web Response",
  'const r = redirect("/done")',
  "r.status              // 302",
  'r.headers.get("location")',
  "r instanceof Response // true",
  "",
  "// 3.0 - a redirect is plain render data",
  'const r = redirect("/done")',
  "r.plain               // { status, headers, body }",
  "r.toResponse()        // build a Response only when something genuinely needs one",
  "",
  "// Add headers through the second argument; cookies still ride c.set as before.",
  'redirect("/done", { status: 307, headers: { "cache-control": "no-store" } })',
].join("\n")

const RESERVED = [
  "// A route whose path segment spells a reserved client key",
  "// (get/post/put/patch/delete/head/options, subscribe/ws/index/then)",
  "// is no longer reachable by property access:",
  "api.posts.delete.get()   // 3.0: type error - `delete` is a reserved verb key",
  "",
  "// The typed spelling is a call on the parent node with the segment:",
  'api.posts("delete").get() // reaches /posts/delete',
].join("\n")

const RESERVED_SET = [
  "// doc-check: skip - fragment reads the exported reserved-key contract",
  "import { RESERVED_VERB_KEYS, RESERVED_EXACT_KEYS, reservedKeyFor } from '@nifrajs/client'",
  "",
  "reservedKeyFor('delete') // 'delete'",
  "reservedKeyFor('posts')  // undefined",
].join("\n")

const PROXY = [
  "// doc-check: skip - fragment shows the Node transport default and its override",
  "import { createProxy } from '@nifrajs/proxy'",
  "import { undiciTransport } from '@nifrajs/proxy/undici'",
  "",
  "// 3.0 on Node: undici is the default transport.",
  "const proxy = createProxy({ target })",
  "",
  "// Override it explicitly when a different transport is wanted:",
  "const custom = createProxy({ target, transport: undiciTransport() })",
].join("\n")

export default function Migrate3() {
  return (
    <div className="prose">
      <h1 className="page">Upgrading from Nifra 2.x to 3.0</h1>
      <p className="lead">
        Nifra 3.0 makes a redirect the same plain-data value an ordinary return is, and freezes the
        reserved typed-client segment keys into a published contract. The upgrade command handles the
        deterministic dependency pins; this guide covers the two structural changes it deliberately
        cannot guess, plus the Node proxy transport default.
      </p>

      <h2>1. Run the executable upgrade</h2>
      <CodeBlock code={COMMANDS} lang="sh" />
      <p>
        The command pins every matching <code>@nifrajs/*</code>, <code>Nifra</code>, and{" "}
        <code>create-nifra</code> dependency to <code>3.0.0</code> while preserving
        caret/tilde/exact style. No package is removed and no import specifier moves this release, so
        the runner only pins. Dry-run is the default; <code>--write</code> applies and verifies with{" "}
        <code>nifra check</code>.
      </p>

      <h2>2. Read redirects as plain data</h2>
      <p>
        <code>redirect(...)</code> now returns the same plain render value <code>status(...)</code>{" "}
        produces, not a Web <code>Response</code>. Same bytes on the wire, now with a{" "}
        <code>content-length</code> on Node instead of a chunked empty body. It is still returned or
        thrown from the same places - loader, action, layout gate - and <code>return redirect()</code>{" "}
        / <code>throw redirect()</code> stay interchangeable, including the client-submit conversion to
        a 204 with <code>X-Nifra-Redirect</code>.
      </p>
      <p>
        <strong>Breaking:</strong> the value is no longer a <code>Response</code>, so{" "}
        <code>.status</code>, <code>.headers</code>, and <code>instanceof Response</code> are gone from
        it. Read <code>.plain</code>, build one with <code>toResponse()</code> when needed, pass headers
        through the second argument, and assert on <code>.plain</code> in tests. A hand-rolled{" "}
        <code>Response</code> from a loader or action is untouched - only what <code>redirect()</code>{" "}
        itself returns changed.
      </p>
      <CodeBlock code={REDIRECT} lang="ts" />

      <h2>3. Fix reserved typed-client segments</h2>
      <p>
        The reserved proxy keys are now a frozen, published contract. A route whose static path
        segment spells one of them - an HTTP verb in any casing, or <code>subscribe</code>,{" "}
        <code>ws</code>, <code>index</code>, <code>then</code> - is unreachable by property access,
        because the proxy resolves the reserved key before a path segment. The types now reject that
        access at compile time instead of silently reaching the wrong node.
      </p>
      <CodeBlock code={RESERVED} lang="ts" />
      <p>
        Run <code>nifra fix --code NF-C018</code> to rewrite the affected call sites. It reads them
        from the compiler rather than a text search, so it finds every one and never mistakes a real{" "}
        <code>.delete</code> verb call for a path segment; a site it cannot rewrite confidently
        (bracket access, a node held in a variable) is reported and left alone.{" "}
        <code>nifra routes</code> annotates a colliding route with the spelling that reaches it, in
        both the table and <code>--json</code>. The set is exported as the one place it is written down.
      </p>
      <CodeBlock code={RESERVED_SET} lang="ts" />

      <h2>4. Review the Node proxy transport (only if you use it)</h2>
      <p>
        On Node, <code>@nifrajs/proxy</code> now defaults to the undici transport, shipped from the new{" "}
        <code>@nifrajs/proxy/undici</code> subpath. Pass an explicit <code>transport</code> to{" "}
        <code>createProxy</code> to override it.
      </p>
      <CodeBlock code={PROXY} lang="ts" />

      <h2>5. Run the release gates</h2>
      <ol>
        <li>
          Run <code>nifra check --json</code> and fix every error, including any remaining NF-C018.
        </li>
        <li>
          If the project has <code>nifra.assurance.ts</code>, run <code>nifra assure --json</code>.
        </li>
        <li>Run the application test suite and a production build.</li>
        <li>
          Exercise every redirect path - loader, action, and layout gate - and, if the app proxies,
          each deploy adapter it uses.
        </li>
      </ol>
    </div>
  )
}
