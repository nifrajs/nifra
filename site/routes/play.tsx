import {
  PLAYGROUND_ENTRY,
  PLAYGROUND_STARTER_CODE,
  PLAYGROUND_STARTER_REQUESTS,
} from "../islands/entries"
import { pageMeta } from "../meta"

export const meta = pageMeta(
  "Nifra — Playground",
  "Run a real Nifra server() app in your browser — define routes, validate with t, fire requests through app.fetch, see the responses. No backend; the same @nifrajs/core that runs on the server.",
)

// Static page (no React client entry) — the interactive logic ships as a vanilla-JS island that
// bundles @nifrajs/core + schema + runner and runs the user's app via app.fetch, entirely client-side.
// `hydrate: false` keeps React from re-rendering (and resetting) the DOM the island owns.
export const hydrate = false
export const islandScripts = [PLAYGROUND_ENTRY]

function Dots() {
  return (
    <span className="code-window-dots" aria-hidden="true">
      <span className="code-window-dot red" />
      <span className="code-window-dot yellow" />
      <span className="code-window-dot green" />
    </span>
  )
}

export default function Play() {
  return (
    <div className="play">
      <header className="play-head">
        <span className="kicker">Playground</span>
        <h1 className="page">Run a real Nifra app, in your browser.</h1>
        <p className="lead">
          This runs the <b>actual</b> <code>@nifrajs/core</code> — no backend. Define an app with{" "}
          <code>server()</code> (and validate with <code>t</code>), fire requests through{" "}
          <code>app.fetch</code>, and see the structured responses. It's the same engine coding
          agents run through <code>nifra mcp</code>.
        </p>
      </header>

      {/* Sticky controls — presets + Run stay reachable above the editors. */}
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
        </div>
      </div>

      {/* Editor-first: code spans the top; requests (write) + response (see) sit paired below. */}
      <div className="play-grid">
        <section className="play-pane play-pane--code" aria-label="Code editor">
          <div className="play-pane-head">
            <Dots />
            <span className="play-window-title">app.ts</span>
            <span className="play-pane-hint">server &amp; t in scope — return the app</span>
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

        <section className="play-pane play-pane--requests" aria-label="Requests">
          <div className="play-pane-head">
            <Dots />
            <span className="play-window-title">requests.json</span>
            <span className="play-pane-hint">array of {"{ method?, path, body? }"}</span>
          </div>
          <textarea
            id="play-requests"
            className="play-editor play-editor-requests"
            aria-label="Requests"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            defaultValue={PLAYGROUND_STARTER_REQUESTS}
          />
        </section>

        <section className="play-pane play-pane--results" aria-label="Response">
          <div className="play-pane-head">
            <Dots />
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
