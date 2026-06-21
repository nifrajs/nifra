import { FRAMEWORK_DATA_GLOBAL, frameworkStageId } from "../frameworks/data"
import {
  FRAMEWORK_DEMO_DATA,
  FRAMEWORK_ENTRIES,
  FRAMEWORK_ITEM_COUNT,
} from "../frameworks/generated"
import { FRAMEWORKS_ENTRY } from "../islands/entries"
import { pageMeta } from "../meta"

export const meta = pageMeta(
  "Nifra — Same app, five frameworks",
  "One Nifra app, one data loader, rendered through React, Preact, Vue, Solid, and Svelte — with each framework's real, measured hydration-JS gzip size side by side.",
)

// Static showcase: the host route ships NO framework runtime of its own (`hydrate: false`). Each of the
// five rows is server-rendered into its own stage; the toggle island (vanilla JS) lazily hydrates the
// shown one by loading that framework's real client bundle. So React never re-renders this DOM, and the
// only request-time cost is five small HTML fragments + one ~1 KB island.
export const hydrate = false
export const islandScripts = [FRAMEWORKS_ENTRY]

// The five entries, smallest gzip first — so the bars chart reads as an ascending ladder and React's
// ~10× tail is the punchline. Reordering for display only; identity/data are unchanged.
const ROWS = [...FRAMEWORK_ENTRIES].sort((a, b) => a.bytesGzip - b.bytesGzip)
const MAX_GZIP = Math.max(...ROWS.map((r) => r.bytesGzip))
const ACTIVE_ID = ROWS[0]?.id ?? "react"

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`

// The island's config — bundle URLs + the per-adapter hydration head + the shared catalog payload.
// Embedded in a `type="application/json"` script (inert: the browser never executes it); `<` is escaped
// so a `</script>` inside Solid's hydration-head string can't break out of the tag.
const CONFIG_JSON = JSON.stringify({
  activeId: ACTIVE_ID,
  dataGlobal: FRAMEWORK_DATA_GLOBAL,
  data: FRAMEWORK_DEMO_DATA,
  frameworks: FRAMEWORK_ENTRIES.map((e) => ({
    id: e.id,
    bundleUrl: e.bundleUrl,
    hydrationHead: e.hydrationHead,
  })),
}).replace(/</g, "\\u003c")

export default function Frameworks() {
  return (
    <div className="fw">
      <header className="fw-head">
        <span className="kicker">One core, five UIs</span>
        <h1 className="page">The same app, in five frameworks.</h1>
        <p className="lead">
          This is <b>one</b> Nifra app — one <code>{FRAMEWORK_ITEM_COUNT}</code>-item data loader,
          one component per framework — rendered through all five <code>@nifrajs/web</code>{" "}
          adapters. Every row is server-rendered to identical markup; flip a framework and its{" "}
          <b>real</b> client bundle loads and hydrates the panel live. The sizes below aren't
          estimates — they're the gzip bytes this site's build measured for each hydration bundle.
        </p>
      </header>

      {/* Toggle — one button per framework, each showing its measured gzip size. A fieldset groups the
          segmented control (same idiom as /play's preset segment). */}
      <fieldset className="fw-toggle" aria-label="Choose a framework">
        {ROWS.map((row) => (
          <button
            key={row.id}
            type="button"
            className={`fw-toggle-btn${row.id === ACTIVE_ID ? " active" : ""}`}
            data-fw-toggle={row.id}
            aria-pressed={row.id === ACTIVE_ID ? "true" : "false"}
          >
            {row.label}
            <span className="fw-toggle-size">{kb(row.bytesGzip)}</span>
          </button>
        ))}
      </fieldset>

      <div className="fw-panels">
        {/* Five stages, one per framework. All server-rendered; only the active one is shown. The
            fragment is trusted, build-time HTML (rendered by our own adapters from a fixed 50-item
            payload — never user input), so dangerouslySetInnerHTML is safe here, same as highlight.tsx. */}
        <div className="fw-stage-wrap">
          <div className="fw-stage-head">
            <span className="fw-stage-title">catalog.app</span>
            <span className="fw-stage-live">live</span>
          </div>
          <div className="fw-stage-body">
            {FRAMEWORK_ENTRIES.map((row) => (
              <div
                key={row.id}
                data-fw-stage={row.id}
                id={frameworkStageId(row.id)}
                hidden={row.id !== ACTIVE_ID}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted build-time SSR fragment
                dangerouslySetInnerHTML={{ __html: row.fragmentHtml }}
              />
            ))}
          </div>
        </div>

        {/* Size ladder — the measured gzip bundle per framework. */}
        <aside className="fw-sizes" aria-label="Measured client bundle sizes">
          <h3>Hydration JS, gzipped</h3>
          <p className="fw-sizes-sub">
            What ships to the browser to make this panel interactive — measured at build time with
            <code> gzip -9</code>.
          </p>
          {ROWS.map((row) => (
            <div
              key={row.id}
              className={`fw-bar-row${row.id === ACTIVE_ID ? " active" : ""}`}
              data-fw-bar={row.id}
            >
              <span className="fw-bar-name">
                {row.label}
                <span className="fw-bar-idiom">{row.idiom}</span>
              </span>
              <span className="fw-bar-track">
                <span
                  className="fw-bar-fill"
                  style={{ width: `${Math.max(6, Math.round((row.bytesGzip / MAX_GZIP) * 100))}%` }}
                />
              </span>
              <span className="fw-bar-value">{kb(row.bytesGzip)}</span>
            </div>
          ))}
        </aside>
      </div>

      <p className="fw-foot">
        Same loaders, streaming, islands, routing, and query cache across all five — only the
        adapter changes. Authored in <code>bench/ssr</code>, measured by{" "}
        <code>site/build-frameworks.ts</code>, and prerendered into this page (the request-time
        worker stays React-only — it never loads five runtimes).
      </p>

      {/* The island reads this inert JSON to find each framework's bundle + hydration head. */}
      <script
        id="fw-config"
        type="application/json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: inert JSON, `<` escaped above
        dangerouslySetInnerHTML={{ __html: CONFIG_JSON }}
      />

      <noscript>
        <p className="fw-noscript">
          The panels are server-rendered, so the markup is identical with JavaScript off — toggling
          and live hydration need JavaScript.
        </p>
      </noscript>
    </div>
  )
}
