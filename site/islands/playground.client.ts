/**
 * The /play enhancer - the interactive playground, as a self-contained browser island. It bundles the
 * real `@nifrajs/core` (`server`), `@nifrajs/schema` (`t`), and `@nifrajs/runner` (`runApp`) - the SAME code
 * that runs on the server - and runs the user's app entirely client-side via `app.fetch`. No backend:
 * `server()`/`app.fetch` are Web-standard (the only Bun-specific bit, `.listen()`, is never called here),
 * so the whole request lifecycle works in the tab.
 *
 * The user's snippet runs through `new Function` - it's their own code, in their own tab (same trust as
 * the devtools console), and it never leaves the browser.
 */

import { server, status } from "@nifrajs/core/server"
import { type AppLike, type RunResult, runApp } from "@nifrajs/runner"
import { t } from "@nifrajs/schema"
import { highlight } from "../shared/highlight"
import {
  codeRuns,
  PLAYGROUND_PRESETS,
  type PlaygroundPreset,
} from "../shared/islands/playground-presets"
import { decodeState, encodeState, readShareHash, shareHash } from "./share-codec"

const REASONS: Readonly<Record<number, string>> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  418: "I'm a teapot",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
}

const $ = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel)

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text // textContent → no HTML injection
  return node
}

/** Fill a node from prose whose backticks mark inline code, without parsing any HTML. */
function setProse(node: HTMLElement | null, text: string): void {
  if (!node) return
  node.replaceChildren(
    ...codeRuns(text).map((run) => (run.code ? el("code", undefined, run.text) : run.text)),
  )
}

/** `highlight` escapes every character it emits, so its output is safe to assign as markup. A text
 * ending in a newline needs one more character, or the layer is a line shorter than the textarea. */
function paint(layer: HTMLElement, text: string): void {
  layer.innerHTML = highlight(text.endsWith("\n") ? `${text} ` : text)
}

interface Editor {
  readonly input: HTMLTextAreaElement
  readonly layer: HTMLElement
}

function editor(id: string): Editor | null {
  const input = $<HTMLTextAreaElement>(`#${id}`)
  const layer = input?.parentElement?.querySelector<HTMLElement>(".play-hl")
  return input && layer ? { input, layer } : null
}

function setEditor(ed: Editor, text: string): void {
  ed.input.value = text
  paint(ed.layer, text)
  ed.layer.scrollTop = 0
  ed.layer.scrollLeft = 0
}

/** What an unlabelled response means, for the responses Nifra itself writes. */
function noteFor(r: RunResult): string | undefined {
  if (r.error) return "app.fetch threw instead of returning a response."
  const body = r.body
  const error =
    typeof body === "object" && body !== null && "error" in body ? body.error : undefined
  if (r.status === 422 && error === "validation") {
    return "Rejected by the route's schema. The handler did not run."
  }
  if (r.status === 404 && error === "not_found") return "No route matches this method and path."
  if (r.status === 500 && error === "internal_error") {
    return "The handler threw. Nifra answered 500 and logged the error to the browser console."
  }
  return undefined
}

/** JSON.stringify with two-space indent, except that any object or array short enough stays on one
 * line - a validation issue's `"path": ["name"]` reads at a glance instead of over four lines. */
function formatJson(value: unknown, indent = ""): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  const inner = `${indent}  `
  const isArray = Array.isArray(value)
  const entries = isArray
    ? value.map((item) => formatJson(item, inner))
    : Object.entries(value).map(
        ([key, item]) => `${JSON.stringify(key)}: ${formatJson(item, inner)}`,
      )
  if (entries.length === 0) return isArray ? "[]" : "{}"
  const flat = isArray ? `[${entries.join(", ")}]` : `{ ${entries.join(", ")} }`
  if (flat.length <= 56 && !flat.includes("\n")) return flat
  const [open, close] = isArray ? ["[", "]"] : ["{", "}"]
  return `${open}\n${entries.map((entry) => inner + entry).join(",\n")}\n${indent}${close}`
}

function statusLabel(r: RunResult): HTMLElement {
  if (r.error) return el("span", "play-status play-status--err", "threw")
  const code = r.status ?? 0
  const tone = code >= 500 ? "err" : code >= 400 ? "warn" : "ok"
  const reason = r.statusText || REASONS[code] || ""
  return el("span", `play-status play-status--${tone}`, reason ? `${code} ${reason}` : String(code))
}

function renderResult(r: RunResult): HTMLElement {
  const item = el("article", "play-result")
  const line = el("div", "play-result-line")
  line.append(el("span", "play-method", r.method), el("span", "play-path", r.path), statusLabel(r))
  item.append(line)

  const note = r.label ?? noteFor(r)
  if (note) item.append(el("p", "play-note", note))

  const body = el("pre", r.error ? "play-response play-response--err" : "play-response")
  if (r.error) {
    body.textContent = r.error.message
  } else if (typeof r.body === "string") {
    body.textContent = r.body === "" ? "(empty body)" : r.body
  } else {
    body.innerHTML = highlight(formatJson(r.body))
  }
  item.append(body)
  return item
}

/** The code or the requests did not run at all - say which, and what to do about it. */
function renderProblem(title: string, detail: string, hint?: string): HTMLElement {
  const box = el("div", "play-problem")
  box.append(
    el("p", "play-problem-title", title),
    el("pre", "play-response play-response--err", detail),
  )
  if (hint) box.append(el("p", "play-note", hint))
  return box
}

interface Ui {
  readonly code: Editor
  readonly reqs: Editor
  readonly out: HTMLElement
  readonly meta: HTMLElement | null
}

function isApp(value: unknown): value is AppLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function"
  )
}

async function run(ui: Ui): Promise<void> {
  let app: unknown
  try {
    // The snippet is the user's own code, running in their own tab - same trust as the console.
    const factory = new Function("server", "t", "status", ui.code.input.value)
    app = factory(server, t, status)
  } catch (err) {
    show(ui, "Your code did not run", err, "Fix it in app.ts and press Run again.")
    return
  }
  if (!isApp(app)) {
    show(
      ui,
      "No app was returned",
      "The code ran, but it did not return a Nifra app.",
      "End app.ts with: return app",
    )
    return
  }

  let requests: unknown
  try {
    requests = JSON.parse(ui.reqs.input.value)
  } catch (err) {
    showFile("requests")
    show(ui, "requests.json is not valid JSON", err, 'Each request is { "path": "/..." }.')
    return
  }
  if (!Array.isArray(requests)) {
    showFile("requests")
    show(ui, "requests.json must be an array", "Wrap the requests in [ ].")
    return
  }

  try {
    const results = await runApp(app, requests)
    ui.out.replaceChildren(...results.map(renderResult))
    if (results.length === 0) {
      ui.out.replaceChildren(
        el("p", "play-idle", "requests.json is empty. Add a request to see a response."),
      )
    }
    if (ui.meta) {
      ui.meta.textContent = `${results.length} ${results.length === 1 ? "request" : "requests"} via app.fetch`
    }
  } catch (err) {
    show(ui, "The requests could not be sent", err)
  }
  ui.out.scrollTop = 0
}

function show(ui: Ui, title: string, detail: unknown, hint?: string): void {
  const text = detail instanceof Error ? detail.message : String(detail)
  ui.out.replaceChildren(renderProblem(title, text, hint))
  if (ui.meta) ui.meta.textContent = "not run"
}

function syncRequestCount(reqs: HTMLTextAreaElement): void {
  const label = $<HTMLElement>("#play-requests-count")
  if (!label) return
  try {
    const parsed: unknown = JSON.parse(reqs.value)
    label.textContent = Array.isArray(parsed) ? String(parsed.length) : "!"
  } catch {
    label.textContent = "!"
  }
}

const FILES = ["code", "requests"] as const
type FileTab = (typeof FILES)[number]

function showFile(file: FileTab, focus = false): void {
  for (const name of FILES) {
    const tab = $<HTMLButtonElement>(`#play-${name}-tab`)
    const panel = $<HTMLElement>(`#play-${name}-panel`)
    const active = name === file
    tab?.setAttribute("aria-selected", String(active))
    if (tab) tab.tabIndex = active ? 0 : -1
    if (panel) panel.hidden = !active
    if (active && focus) tab?.focus()
  }
}

function explain(preset: PlaygroundPreset | undefined): void {
  setProse($("#play-shows"), preset?.shows ?? "Your own code. Edit it, then press Run.")
  setProse($("#play-try"), preset?.tryThis ?? "Pick an example above to start from one.")
}

/** Encode the current editors into a `#play=` link, push it to the address bar, and copy it. */
async function share(ui: Ui, button: HTMLButtonElement, msg: HTMLElement | null): Promise<void> {
  let note: string
  try {
    const hash = shareHash(
      await encodeState({ code: ui.code.input.value, requests: ui.reqs.input.value }),
    )
    const url = location.origin + location.pathname + location.search + hash
    history.replaceState(null, "", hash) // make the link real without a reload
    note = url.length > 8000 ? "Copied (long link)" : "Link copied"
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      note = "Link in address bar"
    }
  } catch {
    note = "Couldn't build link"
  }
  button.textContent = note
  if (msg) msg.textContent = note
  window.setTimeout(() => {
    button.textContent = "Share"
    if (msg) msg.textContent = ""
  }, 2400)
}

async function init(): Promise<void> {
  const code = editor("play-code")
  const reqs = editor("play-requests")
  const out = $<HTMLElement>("#play-results")
  const runBtn = $<HTMLButtonElement>("#play-run")
  if (!code || !reqs || !out || !runBtn) return
  const ui: Ui = { code, reqs, out, meta: $<HTMLElement>("#play-out-meta") }

  // Embed mode (`?embed=1`) drops the site chrome so /play can live in an <iframe>.
  if (new URLSearchParams(location.search).has("embed")) {
    document.documentElement.classList.add("play-embed")
  }
  if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
    const kbd = $<HTMLElement>("#play-kbd")
    if (kbd) {
      kbd.textContent = "Ctrl ↵"
      kbd.setAttribute("aria-label", "Control Enter")
    }
  }

  let active: PlaygroundPreset | undefined = PLAYGROUND_PRESETS[0]
  const reset = $<HTMLButtonElement>("#play-reset")
  const markEdited = (): void => {
    if (reset && active) {
      reset.hidden = code.input.value === active.code && reqs.input.value === active.requests
    }
  }

  for (const ed of [code, reqs]) {
    ed.input.addEventListener("input", () => {
      paint(ed.layer, ed.input.value)
      markEdited()
    })
    ed.input.addEventListener("scroll", () => {
      ed.layer.scrollTop = ed.input.scrollTop
      ed.layer.scrollLeft = ed.input.scrollLeft
    })
    // Cmd/Ctrl+Enter runs from either editor - the expected hotkey for a code playground.
    ed.input.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault()
        void run(ui)
      }
    })
  }
  reqs.input.addEventListener("input", () => syncRequestCount(reqs.input))
  runBtn.addEventListener("click", () => void run(ui))

  for (const file of FILES) {
    const tab = $<HTMLButtonElement>(`#play-${file}-tab`)
    tab?.addEventListener("click", () => showFile(file))
    tab?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      event.preventDefault()
      showFile(file === "code" ? "requests" : "code", true)
    })
  }

  const shareBtn = $<HTMLButtonElement>("#play-share")
  const shareMsg = $<HTMLElement>("#play-share-msg")
  shareBtn?.addEventListener("click", () => void share(ui, shareBtn, shareMsg))

  const exampleButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-preset]")]
  const select = (preset: PlaygroundPreset | undefined): void => {
    active = preset
    for (const btn of exampleButtons) {
      btn.setAttribute("aria-pressed", String(btn.dataset.preset === preset?.id))
    }
    explain(preset)
    if (reset) reset.hidden = true
  }
  const load = (preset: PlaygroundPreset): void => {
    select(preset)
    setEditor(code, preset.code)
    setEditor(reqs, preset.requests)
    syncRequestCount(reqs.input)
    showFile("code")
    void run(ui)
  }
  for (const btn of exampleButtons) {
    const preset = PLAYGROUND_PRESETS.find((p) => p.id === btn.dataset.preset)
    if (preset) btn.addEventListener("click", () => load(preset))
  }
  reset?.addEventListener("click", () => {
    if (active) load(active)
  })

  // A share link (`#play=…`) reconstructs custom editor state; otherwise the SSR'd starter stands.
  // Never inside a frame: a page framing /play could load code of its choosing and steer a click onto
  // Run, which runs it on this origin. The home page's own embed carries no share link.
  const payload = window.self === window.top ? readShareHash(location.hash) : null
  const restored = payload ? await decodeState(payload) : null
  if (restored) {
    select(undefined)
    setEditor(code, restored.code)
    setEditor(reqs, restored.requests)
    syncRequestCount(reqs.input)
    out.replaceChildren(
      el(
        "p",
        "play-idle",
        "This code came from a share link. Read it first: it runs in this tab when you press Run.",
      ),
    )
    if (ui.meta) ui.meta.textContent = "not run"
    return
  }
  // Run once so the responses are there on first paint.
  void run(ui)
}

void init()
