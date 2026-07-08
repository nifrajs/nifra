/**
 * The /play enhancer — the interactive playground, as a self-contained browser island. It bundles the
 * real `@nifrajs/core` (`server`), `@nifrajs/schema` (`t`), and `@nifrajs/runner` (`runApp`) — the SAME code
 * that runs on the server — and runs the user's app entirely client-side via `app.fetch`. No backend:
 * `server()`/`app.fetch` are Web-standard (the only Bun-specific bit, `.listen()`, is never called here),
 * so the whole request lifecycle works in the tab.
 *
 * The user's snippet runs through `new Function` — it's their own code, in their own tab (same trust as
 * the devtools console), and it never leaves the browser.
 */

import { server } from "@nifrajs/core"
import { type RunResult, runApp } from "@nifrajs/runner"
import { t } from "@nifrajs/schema"
import { decodeState, encodeState, readShareHash, shareHash } from "./share-codec"

interface Preset {
  readonly label: string
  readonly code: string
  readonly requests: string
}

const PRESETS: Readonly<Record<string, Preset>> = {
  hello: {
    label: "Typed API",
    code: `// \`server\` and \`t\` are in scope. Build an app and \`return\` it.
const app = server()
  .get("/hello/:name", (c) => ({ hello: c.params.name }))
  .get("/add", { query: t.object({ a: t.string(), b: t.string() }) }, (c) => ({
    sum: Number(c.query.a) + Number(c.query.b),
  }))

return app`,
    requests: `[
  { "path": "/hello/world" },
  { "path": "/add?a=2&b=3" }
]`,
  },
  validation: {
    label: "Validation",
    code: `// Inputs are validated at the boundary with \`t\`. An invalid body is rejected
// with a 400 BEFORE your handler runs — edit the second request to see it.
const app = server()
  .post(
    "/users",
    { body: t.object({ name: t.string({ minLength: 1 }), age: t.number() }) },
    (c) => ({ id: crypto.randomUUID(), ...c.body }),
  )

return app`,
    requests: `[
  { "method": "POST", "path": "/users", "body": { "name": "Ada", "age": 36 } },
  { "method": "POST", "path": "/users", "body": { "name": "", "age": "oops" } }
]`,
  },
  responses: {
    label: "Status & Response",
    code: `// Return a plain value for JSON, or a Response for full control.
const app = server()
  .get("/users/:id", (c) =>
    c.params.id === "1"
      ? { id: "1", name: "Ada" }
      : new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
  )
  .get("/teapot", () => new Response("short and stout", { status: 418 }))

return app`,
    requests: `[
  { "path": "/users/1" },
  { "path": "/users/2" },
  { "path": "/teapot" }
]`,
  },
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

/** A status badge whose tone follows the HTTP class (2xx ok, 4xx warn, 5xx / crash error). */
function statusBadge(r: RunResult): HTMLElement {
  if (r.error) return el("span", "play-badge play-badge-err", "threw")
  const status = r.status ?? 0
  const tone = status >= 500 ? "err" : status >= 400 ? "warn" : "ok"
  return el("span", `play-badge play-badge-${tone}`, String(status))
}

/** Render one request's result as a card (all via textContent — the body never becomes live HTML). */
function renderResult(r: RunResult): HTMLElement {
  const card = el("div", "play-card")
  const head = el("div", "play-card-head")
  head.append(el("span", "play-method", r.method), el("span", "play-path", r.path), statusBadge(r))
  card.append(head)

  const body = r.error
    ? r.error.message
    : typeof r.body === "string"
      ? r.body
      : JSON.stringify(r.body, null, 2)
  card.append(el("pre", r.error ? "play-body play-body-err" : "play-body", body))
  return card
}

function load(preset: Preset, code: HTMLTextAreaElement, reqs: HTMLTextAreaElement): void {
  code.value = preset.code
  reqs.value = preset.requests
}

async function run(
  code: HTMLTextAreaElement,
  reqs: HTMLTextAreaElement,
  out: HTMLElement,
): Promise<void> {
  out.replaceChildren(el("div", "play-running", "Running…"))
  try {
    // The snippet is the user's own code, running in their own tab — same trust as the console.
    const factory = new Function("server", "t", code.value) as (s: unknown, t: unknown) => unknown
    const app = factory(server, t) as { fetch?: unknown } | undefined
    if (!app || typeof app.fetch !== "function") {
      throw new Error("Your code must `return` a nifra app — e.g. `return server().get(...)`.")
    }
    let requests: unknown
    try {
      requests = JSON.parse(reqs.value)
    } catch {
      throw new Error("Requests must be valid JSON (an array of { method?, path, body? }).")
    }
    if (!Array.isArray(requests)) throw new Error("Requests must be a JSON array.")

    const results = await runApp(
      app as { fetch(r: Request): Response | Promise<Response> },
      requests,
    )
    out.replaceChildren(...results.map(renderResult))
  } catch (err) {
    const card = el("div", "play-card")
    card.append(
      el("pre", "play-body play-body-err", err instanceof Error ? err.message : String(err)),
    )
    out.replaceChildren(card)
  }
}

/** Encode the current editors into a `#play=` link, push it to the address bar, and copy it. */
async function share(
  code: HTMLTextAreaElement,
  reqs: HTMLTextAreaElement,
  msg: HTMLElement | null,
): Promise<void> {
  let note: string
  try {
    const hash = shareHash(await encodeState({ code: code.value, requests: reqs.value }))
    const url = location.origin + location.pathname + location.search + hash
    history.replaceState(null, "", hash) // make the link real without a reload
    note = url.length > 8000 ? "Copied — long link, may not paste everywhere" : "Link copied"
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      note = "Link is in your address bar (clipboard blocked)"
    }
  } catch {
    note = "Couldn't build the link"
  }
  if (msg) {
    msg.textContent = note
    window.setTimeout(() => {
      if (msg.textContent === note) msg.textContent = ""
    }, 4000)
  }
}

async function init(): Promise<void> {
  const code = $<HTMLTextAreaElement>("#play-code")
  const reqs = $<HTMLTextAreaElement>("#play-requests")
  const out = $<HTMLElement>("#play-results")
  const runBtn = $<HTMLButtonElement>("#play-run")
  if (!code || !reqs || !out || !runBtn) return

  // Embed mode (`?embed=1`) drops the site chrome so /play can live in an <iframe>.
  if (new URLSearchParams(location.search).has("embed")) {
    document.documentElement.classList.add("play-embed")
  }

  runBtn.addEventListener("click", () => {
    void run(code, reqs, out)
  })
  // Cmd/Ctrl+Enter runs from either editor — the expected hotkey for a code playground.
  const runHotkey = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault()
      void run(code, reqs, out)
    }
  }
  code.addEventListener("keydown", runHotkey)
  reqs.addEventListener("keydown", runHotkey)

  const shareBtn = $<HTMLButtonElement>("#play-share")
  const shareMsg = $<HTMLElement>("#play-share-msg")
  shareBtn?.addEventListener("click", () => {
    void share(code, reqs, shareMsg)
  })

  // ---- AI Copilot Chat Wiring ----
  const aiForm = $<HTMLFormElement>("#play-ai-form")
  const aiInput = $<HTMLInputElement>("#play-ai-input")
  const aiMessages = $<HTMLElement>("#play-ai-messages")

  const appendMsg = (role: "user" | "assistant" | "system", text: string): void => {
    if (!aiMessages) return
    const msg = el("div", `play-ai-msg ${role}`)
    msg.textContent = text
    aiMessages.appendChild(msg)
    aiMessages.scrollTop = aiMessages.scrollHeight
  }

  aiForm?.addEventListener("submit", async (e) => {
    e.preventDefault()
    if (!aiInput?.value.trim() || !aiMessages) return
    const promptText = aiInput.value.trim()
    aiInput.value = ""

    appendMsg("user", promptText)

    const loading = el("div", "play-ai-msg assistant", "Nifra Copilot is thinking...")
    aiMessages.appendChild(loading)
    aiMessages.scrollTop = aiMessages.scrollHeight

    try {
      const res = await fetch("/api/playground/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: promptText }),
      })
      loading.remove()

      if (res.ok) {
        const data = (await res.json()) as { message: string; code?: string; requests?: string }
        appendMsg("assistant", data.message)
        if (data.code) {
          code.value = data.code
        }
        if (data.requests) {
          reqs.value = data.requests
        }
        // Remove active class from examples since we replaced code
        for (const other of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
          other.classList.remove("active")
        }
        void run(code, reqs, out)
      } else {
        appendMsg("assistant", "Sorry, I encountered an error communicating with the chat service.")
      }
    } catch (_err) {
      loading.remove()
      appendMsg(
        "assistant",
        "Could not connect to the backend. Please check your network connection.",
      )
    }
  })

  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
    const preset = PRESETS[btn.dataset.preset ?? ""]
    if (!preset) continue
    btn.addEventListener("click", () => {
      // Reflect the active preset in the segmented control.
      for (const other of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
        other.classList.toggle("active", other === btn)
      }
      load(preset, code, reqs)
      void run(code, reqs, out)
    })
  }

  // A share link (`#play=…`) reconstructs custom editor state; otherwise the SSR'd starter stands.
  const payload = readShareHash(location.hash)
  const restored = payload ? await decodeState(payload) : null
  if (restored) {
    code.value = restored.code
    reqs.value = restored.requests
    for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
      btn.classList.remove("active") // custom code — no preset is active
    }
  }
  // Run once so the results panel is populated on first paint (restored or default).
  void run(code, reqs, out)
}

void init()
