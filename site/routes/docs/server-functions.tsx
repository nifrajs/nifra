import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page - no React interactivity (TOC/copy/search are the layout enhancer + the Nira
// island), so ship zero framework JS.
export const hydrate = false

export const meta = pageMeta(
  "Nifra - Server functions",
  "Write a function on the server and call it from a component. The module never reaches the browser, the arguments are validated, and the mounted function is an ordinary route - so assurance, capabilities and the effect ledger all apply.",
  "/docs/server-functions",
)

const DECLARE = `// todos.fn.ts - the suffix is what tells the build to strip this module from the client.
import { serverFn } from "@nifrajs/web/fn"
import { t } from "@nifrajs/schema"
import { createTodo } from "./db/write.ts"

export const addTodo = serverFn(
  { input: t.object({ text: t.string({ minLength: 1 }) }), capabilities: ["db.write"] },
  async ({ text }) => createTodo({ text }),
)`

const MOUNT = `import { server } from "@nifrajs/core/server"
import { serverFunctions } from "@nifrajs/web/fn"
import * as todos from "./todos.fn.ts"

// "todos" is the namespace segment; each export mounts at /_nifra/fn/todos/<exportName>.
export const app = server().use(serverFunctions("todos", todos))`

const CALL = `// doc-check: skip - a component fragment; the import resolves to the build's generated stub.
import { addTodo } from "./todos.fn.ts"

// On the client this import is a stub: (input) => Promise<Output>. Calling it POSTs.
await addTodo({ text: "write the docs" })`

const HOOK = `// doc-check: skip - JSX fragment, shown for the shape rather than compiled here.
import { useServerFn } from "@nifrajs/web-react/fn"
import { addTodo } from "./todos.fn.ts"

function AddTodo() {
  const add = useServerFn(addTodo)
  return (
    <button disabled={add.pending} onClick={() => add.call({ text }).catch(() => {})}>
      {add.pending ? "saving…" : "add"}
    </button>
  )
}`

const ADAPTERS: ReadonlyArray<readonly [string, string]> = [
  ["@nifrajs/web-react/fn", "useSyncExternalStore"],
  ["@nifrajs/web-preact/fn", "useSyncExternalStore"],
  ["@nifrajs/web-solid/fn", "a signal"],
  ["@nifrajs/web-vue/fn", "a shallowRef"],
  ["@nifrajs/web-svelte/fn", "a readable store"],
]

const ASSURE = `# A server function is a public POST endpoint, so the starter policy already covers it.
nifra assure

✖ POST /_nifra/fn/todos/addTodo (authenticated-write) is missing nifra.authenticated`

export default function ServerFunctions() {
  return (
    <div className="prose">
      <h1 className="page">Server functions</h1>
      <p className="lead">
        Write a function on the server, import it in a component, call it. The build replaces the
        module with a typed stub, so the body and everything it imports stay on the server - and
        because the mounted function is an ordinary route, everything you already have for routes
        applies to it unchanged.
      </p>

      <h2>Every server function is a public endpoint</h2>
      <p>
        This is the part to internalise first, because the API deliberately reads like a local call.
        A mounted function is an HTTP route anyone can POST to, with arguments entirely under the
        caller's control, and its id is in the client bundle because the browser needs it. There is no
        obscurity to lean on. Treat one exactly as you would a hand-written <code>app.post</code>.
      </p>
      <p>Four things follow from that, and the API enforces all of them:</p>
      <ul>
        <li>
          <strong>Input is validated, always.</strong> <code>input</code> is not decoration - without a
          schema the function takes no argument at all, because unvalidated arguments on a public
          endpoint are mass assignment.
        </li>
        <li>
          <strong>
            <code>application/json</code> only.
          </strong>{" "}
          A cross-origin HTML form can send urlencoded, multipart or <code>text/plain</code> and
          nothing else, so requiring JSON forces a preflight the browser blocks.
        </li>
        <li>
          <strong>Same-origin only.</strong> A present <code>Origin</code> must match the request's own
          host - defence in depth behind the JSON requirement, at the cost of one comparison.
        </li>
        <li>
          <strong>No closures.</strong> A function is a module-level export taking explicit arguments.
          Serialising closed-over variables to the browser and back is a class of problem worth not
          having rather than encrypting.
        </li>
      </ul>
      <p>
        Both content-type rules were measured rather than assumed. A body schema alone still accepts a
        cross-origin urlencoded form - 200, attacker-controlled fields - and a bounded JSON read alone
        accepts the <code>text/plain</code> trick where a form's <code>name=value</code> is crafted to
        parse as valid JSON. Neither is sufficient by itself.
      </p>

      <h2>Declaring one</h2>
      <CodeBlock code={DECLARE} lang="ts" />
      <p>
        The second argument receives the validated input and the ordinary nifra <code>Context</code>:{" "}
        <code>c.env</code>, <code>c.clientIp</code>, <code>c.budget</code>, cookies and the capability
        guard are all there, because this is a route.
      </p>

      <h2>Mounting</h2>
      <CodeBlock code={MOUNT} lang="ts" />
      <p>
        The namespace becomes a URL segment, so it is constrained to lowercase dot/dash parts. Each
        branded export mounts at <code>/_nifra/fn/&lt;namespace&gt;/&lt;exportName&gt;</code>; anything
        in the module that is not a server function is ignored rather than mounted.
      </p>
      <p>
        One thing worth knowing: the namespace you pass here and the <code>*.fn.ts</code> filename are
        not statically checked against each other. If they disagree the call 404s, and the generated
        stub names the mismatch - but the compiler will not catch it for you.
      </p>

      <h2>Calling it</h2>
      <CodeBlock code={CALL} lang="ts" />
      <p>
        No binding is needed to call one: the client stub is just{" "}
        <code>(input) =&gt; Promise&lt;Output&gt;</code>, and a click handler can await it. The types
        come from the server declaration, so a changed input schema is a compile error at the call
        site.
      </p>

      <h2>Pending, data and error state</h2>
      <p>
        What a component usually wants around the call is state, and state is the part every framework
        spells differently. <code>useServerFn</code> adds exactly that.
      </p>
      <CodeBlock code={HOOK} lang="tsx" />
      <p>The same hook ships for every adapter, each contributing only its subscription primitive:</p>
      <table>
        <thead>
          <tr>
            <th>Import</th>
            <th>Subscribes with</th>
          </tr>
        </thead>
        <tbody>
          {ADAPTERS.map(([specifier, primitive]) => (
            <tr key={specifier}>
              <td>
                <code>{specifier}</code>
              </td>
              <td>{primitive}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        The state machine lives once in <code>@nifrajs/web</code> and each binding contributes only its
        subscription primitive, so "is it pending" has one answer rather than five that drift. Two
        behaviours are worth knowing:
      </p>
      <ul>
        <li>
          <strong>The last call wins.</strong> A response that is no longer the newest is discarded
          rather than written, so a slow first call landing after a fast second cannot overwrite fresh
          data with stale.
        </li>
        <li>
          <strong>
            <code>call</code> still rejects.
          </strong>{" "}
          The error is recorded for rendering AND the promise rejects, so <code>await</code> behaves
          normally. A caller that only renders from state should attach{" "}
          <code>.catch(() =&gt; {})</code>.
        </li>
      </ul>
      <p>
        <code>data</code> is kept while the next call is in flight, so a rendered list does not blank
        on every refetch.
      </p>

      <h2>The client never sees the module</h2>
      <p>
        A <code>*.fn.ts</code> module is not bundled for the browser. The client build replaces it with
        one stub per export, so the bodies - and every module they import, including your database -
        stay on the server. Both pipelines do this identically, and the Bun and Vite transforms are
        held to byte-identical output by a parity test.
      </p>
      <p>
        <code>nifra dev --bun</code> applies it too. Bun's dev-server bundler accepts plugins only
        through bunfig's <code>[serve.static]</code> channel, so that command generates a config
        under <code>.nifra/dev-bun/</code> carrying the same stub plugin and relaunches itself with{" "}
        <code>--config=</code> pointing at it - verified per launch, refusing to serve if the
        boundary cannot be proven active. Identical stubs across all three pipelines.
      </p>

      <h2>It is a route, so assurance applies</h2>
      <p>
        Mounting goes through the ordinary public <code>register()</code>, which is what makes a server
        function inherit the body cap, schema validation, capability declarations, the effect ledger
        and <code>nifra assure</code> for free. The starter policy's{" "}
        <code>authenticated-write</code> rule matches any route declaring a domain write, so a function
        that writes and skips auth fails the check rather than shipping:
      </p>
      <CodeBlock code={ASSURE} lang="bash" />
      <p>
        See <a href="/docs/capabilities">effect provenance</a> for what the declaration is checked
        against, and <a href="/docs/verification">the verification ladder</a> for where this sits.
      </p>

      <h2>Cost</h2>
      <p>
        Nothing here touches the kernel or the request path. An app that mounts no server functions
        pays exactly nothing for the feature - which is the reason it is built as a plugin over the
        public registration API rather than as a bespoke dispatcher.
      </p>
    </div>
  )
}
