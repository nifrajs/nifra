/**
 * Dev-only error overlay. When a loader/action/render throws during `@nifrajs/web/vite` dev, this
 * renders a readable full-page overlay from a structured [Diagnostic] - the code, the message, a source
 * codeframe around the offending line, the recognised cause/fix when nifra has one, and the stack -
 * instead of a bare `err.stack` text dump. Dev-only by construction: it's called solely from the dev
 * server's catch, never in production (production maps errors to the `_error` route boundary).
 *
 * The overlay and the agent surfaces (`/__nifra/last-error`, `nifra_explain`) render from the SAME
 * `Diagnostic`, so a person and an agent see the identical failure, one as HTML and one as JSON.
 */
import { buildDiagnostic, type Diagnostic } from "./diagnostic.ts"

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** The source codeframe block: numbered lines with the offending one highlighted. */
function codeframeHtml(diagnostic: Diagnostic): string {
  const cf = diagnostic.codeframe
  if (cf === undefined) return ""
  const loc = `${esc(cf.file)}:${cf.line}${cf.column !== undefined ? `:${cf.column}` : ""}`
  const rows = cf.lines
    .map(
      (l) =>
        `<div class="cf-row${l.caret ? " caret" : ""}"><span class="cf-ln">${l.number}</span><span class="cf-src">${esc(l.text) || " "}</span></div>`,
    )
    .join("")
  return `<h1>Source</h1><div class="cf-loc">${loc}</div><div class="codeframe">${rows}</div>`
}

/** The recognised-failure callout: cause + fix + docs anchor, shown only when nifra classified the error. */
function fixHtml(diagnostic: Diagnostic): string {
  if (diagnostic.fix === undefined) return ""
  const anchor =
    diagnostic.docsAnchor !== undefined
      ? `<div class="fix-docs">docs: <code>${esc(diagnostic.docsAnchor)}</code></div>`
      : ""
  const cause =
    diagnostic.cause !== undefined ? `<p class="fix-cause">${esc(diagnostic.cause)}</p>` : ""
  return `<div class="fix"><div class="fix-tag">likely fix</div>${cause}<p class="fix-do">${esc(diagnostic.fix)}</p>${anchor}</div>`
}

/** Render the overlay HTML from a prebuilt Diagnostic (the same object the agent surfaces serve). */
export function renderDiagnosticOverlay(diagnostic: Diagnostic): string {
  const name = esc(diagnostic.name || "Error")
  const code = esc(diagnostic.code)
  const reqLine =
    diagnostic.request !== undefined
      ? `<span class="req">${esc(diagnostic.request.method)} ${esc(diagnostic.request.url)}</span>`
      : ""
  const framesHtml =
    diagnostic.frames.length > 0
      ? `<ol class="frames">${diagnostic.frames.map((f) => `<li>${esc(f.raw)}</li>`).join("")}</ol>`
      : `<p class="no-frames">No stack frames.</p>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name} - nifra dev</title>
<style>
  :root { color-scheme: dark }
  body { margin: 0; background: #0b0d10; color: #e6e6e6; font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { background: #2a0e0e; border-bottom: 1px solid #5a1d1d; padding: 10px 20px; font-weight: 700; color: #ff8a8a; display: flex; gap: 12px; align-items: baseline; }
  .bar .tag { font-size: 11px; font-weight: 600; color: #ffb4b4; background: #401616; padding: 2px 8px; border-radius: 99px; letter-spacing: .04em; text-transform: uppercase; }
  .bar .code { font-size: 11px; font-weight: 600; color: #ffd9a0; background: #3a2a12; padding: 2px 8px; border-radius: 99px; letter-spacing: .04em; }
  .bar .req { margin-left: auto; color: #c98; font-weight: 500; font-size: 12px; }
  main { padding: 24px 28px; max-width: 1000px; }
  h1 { font-size: 13px; color: #9aa; font-weight: 600; margin: 24px 0 6px; text-transform: uppercase; letter-spacing: .05em; }
  h1:first-of-type { margin-top: 0; }
  .message { font-size: 18px; color: #ff9b9b; white-space: pre-wrap; margin: 0 0 4px; font-weight: 600; }
  .fix { background: #10241a; border: 1px solid #1f4d38; border-radius: 8px; padding: 12px 16px; margin: 20px 0; }
  .fix-tag { font-size: 11px; font-weight: 700; color: #7fe0af; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 6px; }
  .fix-cause { margin: 0 0 8px; color: #b9c9c1; }
  .fix-do { margin: 0; color: #d6f2e4; }
  .fix-docs { margin-top: 8px; font-size: 12px; color: #6a8; }
  .cf-loc { color: #c98; font-size: 12px; margin-bottom: 8px; }
  .codeframe { background: #0f1319; border: 1px solid #222; border-radius: 8px; overflow: auto; }
  .cf-row { display: flex; white-space: pre; }
  .cf-row.caret { background: #2a1414; }
  .cf-ln { color: #556; text-align: right; width: 48px; padding: 1px 12px 1px 0; user-select: none; flex: none; border-right: 1px solid #222; }
  .cf-row.caret .cf-ln { color: #ff8a8a; }
  .cf-src { padding: 1px 0 1px 12px; color: #cdd6e0; }
  .frames { list-style: none; margin: 0; padding: 0; border-left: 2px solid #333; }
  .frames li { padding: 3px 0 3px 16px; color: #9fb0c0; white-space: pre-wrap; word-break: break-all; }
  .frames li:first-child { color: #d6e2ee; }
  .no-frames { color: #778; }
  footer { margin-top: 28px; color: #667; font-size: 12px; }
</style></head><body>
<div class="bar"><span class="tag">nifra dev</span><span class="code">${code}</span><span>${name}</span>${reqLine}</div>
<main>
  <p class="message">${esc(diagnostic.message)}</p>
  ${fixHtml(diagnostic)}
  ${codeframeHtml(diagnostic)}
  <h1>Stack</h1>
  ${framesHtml}
  <footer>This overlay is shown only by the dev server. Its structured form is at <code>/__nifra/last-error</code> and via <code>nifra_explain</code>. In production this error maps to your <code>_error</code> route boundary.</footer>
</main></body></html>`
}

/**
 * Render the dev error overlay for a thrown value. Back-compatible entry point: builds the Diagnostic
 * (source-mapping is the caller's responsibility, via Vite's `ssrFixStacktrace`) and renders it.
 */
export function renderDevErrorOverlay(err: unknown, req: { method: string; url: string }): string {
  return renderDiagnosticOverlay(buildDiagnostic(err, { request: req }))
}
