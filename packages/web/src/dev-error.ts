/**
 * Dev-only error overlay. When a loader/action/render throws during `@nifrajs/web/vite` dev, this
 * renders a readable full-page overlay — the message, the source-mapped stack (Vite's
 * `ssrFixStacktrace` runs first), and the request line — instead of the bare `err.stack` text dump.
 * Dev-only by construction: it's called solely from the Vite middleware's catch, never in
 * production (production maps errors to the `_error` route boundary).
 */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Split a stack into the message (first line) + the frame lines, for separate styling. */
function parseStack(err: Error): { message: string; frames: string[] } {
  const stack = err.stack ?? `${err.name}: ${err.message}`
  const lines = stack.split("\n")
  // The message can span multiple leading lines (some errors do); frames start at the first "    at ".
  const firstFrame = lines.findIndex((l) => /^\s*at\s/.test(l))
  if (firstFrame === -1) return { message: stack, frames: [] }
  return {
    message: lines.slice(0, firstFrame).join("\n").trim(),
    frames: lines.slice(firstFrame).map((l) => l.trim()),
  }
}

/**
 * Render the dev error overlay HTML. `req` (method + url) is shown for context. The page is
 * self-contained (inline CSS), dark, and labels itself a dev overlay so it's never mistaken for a
 * production error page.
 */
export function renderDevErrorOverlay(err: unknown, req: { method: string; url: string }): string {
  const error = err instanceof Error ? err : new Error(String(err))
  const { message, frames } = parseStack(error)
  const name = esc(error.name || "Error")
  const framesHtml =
    frames.length > 0
      ? `<ol class="frames">${frames.map((f) => `<li>${esc(f)}</li>`).join("")}</ol>`
      : `<p class="no-frames">No stack frames.</p>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name} — nifra dev</title>
<style>
  :root { color-scheme: dark }
  body { margin: 0; background: #0b0d10; color: #e6e6e6; font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { background: #2a0e0e; border-bottom: 1px solid #5a1d1d; padding: 10px 20px; font-weight: 700; color: #ff8a8a; display: flex; gap: 12px; align-items: baseline; }
  .bar .tag { font-size: 11px; font-weight: 600; color: #ffb4b4; background: #401616; padding: 2px 8px; border-radius: 99px; letter-spacing: .04em; text-transform: uppercase; }
  .bar .req { margin-left: auto; color: #c98; font-weight: 500; font-size: 12px; }
  main { padding: 24px 28px; max-width: 1000px; }
  h1 { font-size: 13px; color: #9aa; font-weight: 600; margin: 0 0 6px; text-transform: uppercase; letter-spacing: .05em; }
  .message { font-size: 18px; color: #ff9b9b; white-space: pre-wrap; margin: 0 0 28px; font-weight: 600; }
  .frames { list-style: none; margin: 0; padding: 0; border-left: 2px solid #333; }
  .frames li { padding: 3px 0 3px 16px; color: #9fb0c0; white-space: pre-wrap; word-break: break-all; }
  .frames li:first-child { color: #d6e2ee; }
  .no-frames { color: #778; }
  footer { margin-top: 28px; color: #667; font-size: 12px; }
</style></head><body>
<div class="bar"><span class="tag">nifra dev</span><span>${name}</span><span class="req">${esc(req.method)} ${esc(req.url)}</span></div>
<main>
  <h1>Unhandled error during SSR</h1>
  <p class="message">${esc(message)}</p>
  <h1>Stack</h1>
  ${framesHtml}
  <footer>This overlay is shown only by the dev server. In production this error maps to your <code>_error</code> route boundary.</footer>
</main></body></html>`
}
