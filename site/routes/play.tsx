import { PLAYGROUND_STARTER_CODE, PLAYGROUND_STARTER_REQUESTS } from "../shared/islands/entries"
import { pageMeta } from "../shared/meta"

export const meta = pageMeta(
  "Nifra - Playground",
  "Run a real Nifra server() app in your browser - define routes, validate with t, fire requests through app.fetch, see the responses. No backend; the same @nifrajs/core that runs on the server.",
  "/play",
)

// The starter's request count, so the folded "Requests" row is right before the island runs.
const STARTER_REQUEST_COUNT = (JSON.parse(PLAYGROUND_STARTER_REQUESTS) as readonly unknown[]).length

export default function Play() {
  return (
    <div className="play">
      <header className="play-head">
        <span className="kicker">Playground</span>
        <h1 className="page">Run a real Nifra app, in your browser.</h1>
        <p className="lead">
          This is the real <code>@nifrajs/core</code>, running in this tab. Nothing is sent to a
          server. Pick an example or edit the code, press Run, and read the responses.
        </p>
      </header>

      {/* Sticky controls - presets + Run stay reachable above the editor. */}
      <div className="play-controls">
        <div className="play-presets">
          <span className="play-presets-label">Examples</span>
          <fieldset className="play-segment" aria-label="Example presets">
            <button type="button" className="play-preset active" data-preset="hello">
              Typed API
            </button>
            <button type="button" className="play-preset" data-preset="validation">
              Validation
            </button>
            <button type="button" className="play-preset" data-preset="responses">
              Status &amp; Response
            </button>
          </fieldset>
        </div>
        <div className="play-run-row">
          <button type="button" id="play-run" className="button primary play-run">
            Run ▸
          </button>
          <span className="play-kbd-hint">
            <kbd className="play-kbd">⌘</kbd>
            <kbd className="play-kbd">↵</kbd> to run
          </span>
          <button type="button" id="play-share" className="button ghost play-share">
            Copy share link
          </button>
          <span id="play-share-msg" className="play-share-msg" aria-live="polite" />
        </div>
      </div>

      {/* One place to type (the app), the responses beside it. The requests the run sends are
          folded under the editor: the examples fill them in, so most visitors never open it. */}
      <div className="play-grid">
        <div className="play-col">
          <section className="play-pane play-pane--code" aria-label="Code editor">
            <div className="play-pane-head">
              <span className="play-window-title">app.ts</span>
              <span className="play-pane-hint">server &amp; t in scope - return the app</span>
              <span className="play-lang-badge">TS</span>
            </div>
            <textarea
              id="play-code"
              className="play-editor play-editor-code"
              aria-label="App source code"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              defaultValue={PLAYGROUND_STARTER_CODE}
            />
          </section>

          <details id="play-requests-box" className="play-requests">
            <summary>
              <span className="play-window-title">Requests</span>
              <span id="play-requests-count" className="play-pane-hint">
                {STARTER_REQUEST_COUNT} sent on Run
              </span>
              <span className="play-requests-toggle" aria-hidden="true" />
            </summary>
            <textarea
              id="play-requests"
              className="play-editor play-editor-requests"
              aria-label="Requests, as a JSON array of { method?, path, body? }"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              defaultValue={PLAYGROUND_STARTER_REQUESTS}
            />
          </details>
        </div>

        <section className="play-pane play-pane--results" aria-label="Response">
          <div className="play-pane-head">
            <span className="play-window-title">Response</span>
            <span className="play-live-dot" aria-hidden="true" />
          </div>
          <div id="play-results" className="play-results">
            <div className="play-running">Loading the playground…</div>
          </div>
        </section>
      </div>

      <noscript>
        <p className="play-noscript">
          The playground runs in the browser, so it needs JavaScript enabled.
        </p>
      </noscript>
    </div>
  )
}
