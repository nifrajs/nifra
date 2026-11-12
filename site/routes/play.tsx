import { href } from "@nifrajs/web-react/router"
import { highlight } from "../shared/highlight"
import {
  codeRuns,
  PLAYGROUND_FIRST,
  PLAYGROUND_PRESETS,
} from "../shared/islands/playground-presets"
import { pageMeta } from "../shared/meta"

export const meta = pageMeta(
  "Nifra - Playground",
  "Run a real Nifra server() app in your browser - define routes, validate with t, fire requests through app.fetch, see the responses. No backend; the same @nifrajs/core that runs on the server.",
  "/play",
)

const FIRST_REQUESTS: unknown = JSON.parse(PLAYGROUND_FIRST.requests)
const FIRST_REQUEST_COUNT = Array.isArray(FIRST_REQUESTS) ? FIRST_REQUESTS.length : 0

const REFERENCE: ReadonlyArray<readonly [term: string, description: string]> = [
  [
    "server()",
    "Creates an app. Chain `.get`, `.post`, `.put`, `.patch`, and `.delete` to add routes.",
  ],
  ["c.params", "The values of `:name` segments in the route path."],
  [
    "c.query, c.body",
    "The query string and the parsed JSON body. Declare a `t` schema on the route and they arrive validated and typed.",
  ],
  [
    "t",
    "The schema builder: `t.object`, `t.string`, `t.number`, `t.boolean`, `t.array`, `t.optional`, and `t.query` for query strings. Input that fails gets a 422.",
  ],
  ["status(code, body)", "Responds with any status code and a JSON body."],
  [".derive(fn)", "Runs before every route. Whatever it returns is merged into `c`."],
  [
    "return app",
    "The playground calls `app.fetch` on the app you return. In a project you export it: `export default { fetch: app.fetch }`.",
  ],
  [
    "requests.json",
    "An array of `{ method?, path, headers?, body?, label? }`, sent in order. A `label` is shown above its response.",
  ],
]

function Prose({ text }: { text: string }) {
  return (
    <>
      {codeRuns(text).map((run, index) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: runs of a fixed string never reorder
        run.code ? <code key={index}>{run.text}</code> : run.text,
      )}
    </>
  )
}

/** A textarea over a highlighted copy of its own text: the textarea takes the typing (its glyphs are
 * transparent), the layer underneath shows the colors. The island keeps the two in step. */
function Editor(props: { id: string; label: string; value: string; hidden?: boolean }) {
  return (
    <div
      className="play-editor"
      id={`${props.id}-panel`}
      role="tabpanel"
      aria-labelledby={`${props.id}-tab`}
      hidden={props.hidden}
    >
      <pre
        className="play-hl"
        aria-hidden="true"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight() escapes every character it emits
        dangerouslySetInnerHTML={{ __html: highlight(props.value) }}
      />
      <textarea
        id={props.id}
        className="play-input"
        aria-label={props.label}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        wrap="off"
        defaultValue={props.value}
      />
    </div>
  )
}

export default function Play() {
  return (
    <div className="play">
      <header className="play-head">
        <h1 className="page">Run a real Nifra app in your browser.</h1>
        <p className="lead">
          The real <code>@nifrajs/core</code> runs in this tab. Nothing is installed and nothing is
          sent to a server.
        </p>
      </header>

      <ol className="play-steps" aria-label="How the playground works">
        <li>
          <span className="play-step-n" aria-hidden="true">
            1
          </span>
          <div>
            <strong>Write the app</strong>
            <p>
              <code>server()</code> declares routes and <code>t</code> declares what each one
              accepts. The code returns the app.
            </p>
          </div>
        </li>
        <li>
          <span className="play-step-n" aria-hidden="true">
            2
          </span>
          <div>
            <strong>Send requests</strong>
            <p>
              Each entry in <code>requests.json</code> becomes a real <code>Request</code> passed to{" "}
              <code>app.fetch</code>, the same call Bun, Node, and Deno make.
            </p>
          </div>
        </li>
        <li>
          <span className="play-step-n" aria-hidden="true">
            3
          </span>
          <div>
            <strong>Read the responses</strong>
            <p>The status and body each request got back, exactly as a client would see them.</p>
          </div>
        </li>
      </ol>

      <section className="play-bench" aria-label="Playground">
        <div className="play-toolbar">
          <fieldset className="play-examples" aria-label="Examples">
            {PLAYGROUND_PRESETS.map((preset, index) => (
              <button
                key={preset.id}
                type="button"
                className="play-example"
                data-preset={preset.id}
                aria-pressed={index === 0}
              >
                {preset.label}
              </button>
            ))}
          </fieldset>
          <div className="play-actions">
            <button type="button" id="play-share" className="play-quiet">
              Share
            </button>
            <button type="button" id="play-run" className="button primary play-run">
              Run
              <kbd id="play-kbd" className="play-kbd" aria-label="Command Enter">
                ⌘↵
              </kbd>
            </button>
          </div>
        </div>

        <div className="play-explain">
          <p id="play-shows">
            <Prose text={PLAYGROUND_FIRST.shows} />
          </p>
          <p className="play-try">
            <span className="play-try-label">Try</span>
            <span id="play-try">
              <Prose text={PLAYGROUND_FIRST.tryThis} />
            </span>
          </p>
          <button type="button" id="play-reset" className="play-quiet play-reset" hidden>
            Reset example
          </button>
        </div>

        <div className="play-split">
          <div className="play-src">
            <div className="play-files" role="tablist" aria-label="Files">
              <button
                type="button"
                role="tab"
                id="play-code-tab"
                className="play-file"
                aria-controls="play-code-panel"
                aria-selected="true"
              >
                <span className="play-step-n" aria-hidden="true">
                  1
                </span>
                app.ts
              </button>
              <button
                type="button"
                role="tab"
                id="play-requests-tab"
                className="play-file"
                aria-controls="play-requests-panel"
                aria-selected="false"
                tabIndex={-1}
              >
                <span className="play-step-n" aria-hidden="true">
                  2
                </span>
                requests.json
                <span id="play-requests-count" className="play-count">
                  {FIRST_REQUEST_COUNT}
                </span>
              </button>
            </div>
            <Editor id="play-code" label="App source code" value={PLAYGROUND_FIRST.code} />
            <Editor
              id="play-requests"
              label="Requests, as a JSON array of { method?, path, headers?, body?, label? }"
              value={PLAYGROUND_FIRST.requests}
              hidden
            />
          </div>

          <div className="play-out">
            <div className="play-out-head">
              <span className="play-step-n" aria-hidden="true">
                3
              </span>
              <span className="play-out-title">Responses</span>
              <span id="play-out-meta" className="play-out-meta" />
            </div>
            <div id="play-results" className="play-results" aria-live="polite">
              <p className="play-idle">Loading the playground…</p>
            </div>
          </div>
        </div>
        <span id="play-share-msg" className="sr-only" aria-live="polite" />
      </section>

      <noscript>
        <p className="play-noscript">
          The playground runs in the browser, so it needs JavaScript enabled.
        </p>
      </noscript>

      <section className="play-ref" aria-labelledby="play-ref-title">
        <h2 id="play-ref-title">What each piece does</h2>
        <dl>
          {REFERENCE.map(([term, description]) => (
            <div key={term}>
              <dt>
                <code>{term}</code>
              </dt>
              <dd>
                <Prose text={description} />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="play-next">
        <p>
          Same code, on your machine: <code className="inline">bun create nifra my-app</code>
        </p>
        <a className="button ghost" href={href({ to: "/docs" })}>
          Read the docs
        </a>
      </section>
    </div>
  )
}
