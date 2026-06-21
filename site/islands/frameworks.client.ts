/**
 * The /frameworks toggle island — the only client JS the (static, `hydrate: false`) showcase ships
 * itself: a few hundred bytes of vanilla DOM that switches which framework is shown and lazily makes it
 * LIVE. Each of the five rows is server-rendered into its own `#fw-stage-<id>` (all present, only the
 * active one visible). On first activation of a row it injects that adapter's hydration head (Solid
 * needs it; the others are empty) and imports that framework's real client bundle — so the shown
 * framework genuinely hydrates and runs in the tab. Already-hydrated rows just flip back to visible.
 *
 * No HTML is ever built from strings here: the fragments are baked at build time, and every dynamic
 * value (labels, sizes) the route already rendered. The island only toggles classes, reads its config
 * from an embedded JSON <script>, and dynamic-imports bundle URLs it validates against that config.
 */

interface FrameworkMeta {
  readonly id: string
  /** The client bundle URL — validated against this allowlist before any dynamic import. */
  readonly bundleUrl: string
  /** Per-document bootstrap the adapter's hydration requires (Solid only; "" otherwise). */
  readonly hydrationHead: string
}

interface FrameworksConfig {
  readonly activeId: string
  /** The shared catalog payload — published to the data global before any bundle hydrates. */
  readonly data: unknown
  readonly dataGlobal: string
  readonly frameworks: readonly FrameworkMeta[]
}

/** Parse + shape-check the embedded config. A malformed blob (should never happen — we emit it) leaves
 * the page as the static, server-rendered showcase rather than throwing in the user's tab. */
function readConfig(): FrameworksConfig | null {
  const node = document.getElementById("fw-config")
  if (!node?.textContent) return null
  let raw: unknown
  try {
    raw = JSON.parse(node.textContent)
  } catch {
    return null
  }
  if (typeof raw !== "object" || raw === null) return null
  const c = raw as Record<string, unknown>
  if (
    typeof c.activeId !== "string" ||
    typeof c.dataGlobal !== "string" ||
    !Array.isArray(c.frameworks)
  ) {
    return null
  }
  const frameworks: FrameworkMeta[] = []
  for (const f of c.frameworks) {
    if (typeof f !== "object" || f === null) return null
    const fm = f as Record<string, unknown>
    // Only allow same-origin /assets/* bundle URLs — the dynamic import target is config we emit, but
    // validating it keeps the import() target provably local even if the blob were ever tampered with.
    if (
      typeof fm.id !== "string" ||
      typeof fm.bundleUrl !== "string" ||
      !fm.bundleUrl.startsWith("/assets/") ||
      typeof fm.hydrationHead !== "string"
    ) {
      return null
    }
    frameworks.push({ id: fm.id, bundleUrl: fm.bundleUrl, hydrationHead: fm.hydrationHead })
  }
  return { activeId: c.activeId, data: c.data, dataGlobal: c.dataGlobal, frameworks }
}

/** Tracks which rows have been hydrated so we load each bundle (and inject each head) at most once. */
const hydrated = new Set<string>()

/** Make `meta`'s row live: inject its hydration head (once), publish the data global, import its bundle.
 * Idempotent — a second call for the same id is a no-op (the module is already in the import cache and
 * the row is already hydrated). */
async function ensureLive(meta: FrameworkMeta, data: unknown, dataGlobal: string): Promise<void> {
  if (hydrated.has(meta.id)) return
  hydrated.add(meta.id)
  // The data global is shared (the same static catalog for every row) — set it once, before the first
  // bundle runs. Each client entry reads `globalThis[dataGlobal]` synchronously on import. `globalThis`
  // (not `window`) carries an index signature, matching how the client entries read the same global.
  ;(globalThis as Record<string, unknown>)[dataGlobal] = data
  if (meta.hydrationHead) {
    // Solid's generateHydrationScript() output. It's our own build-time string (no user input), injected
    // once so Solid's client `hydrate` finds the runtime it expects. insertAdjacentHTML on <head> runs
    // the inline <script> (innerHTML would not). Marked so a re-injection is impossible.
    if (!document.querySelector(`script[data-fw-head="${meta.id}"]`)) {
      const wrapper = document.createElement("div")
      wrapper.innerHTML = meta.hydrationHead
      for (const script of Array.from(wrapper.querySelectorAll("script"))) {
        const live = document.createElement("script")
        for (const attr of Array.from(script.attributes)) live.setAttribute(attr.name, attr.value)
        live.textContent = script.textContent
        live.setAttribute("data-fw-head", meta.id)
        document.head.appendChild(live)
      }
    }
  }
  try {
    // The bundle hydrates its own `#fw-stage-<id>` on import. Validated to be a same-origin /assets URL
    // above; the `import(/* @vite-ignore */ ...)` is a plain dynamic import of a first-party module.
    await import(meta.bundleUrl)
  } catch {
    // A failed bundle load leaves the server-rendered (static) markup in place — still correct, just not
    // interactive. Allow a later retry by clearing the hydrated flag.
    hydrated.delete(meta.id)
  }
}

function activate(
  id: string,
  config: FrameworksConfig,
  metaById: ReadonlyMap<string, FrameworkMeta>,
): void {
  const meta = metaById.get(id)
  if (!meta) return
  // Show the chosen stage, hide the rest.
  for (const stage of document.querySelectorAll<HTMLElement>("[data-fw-stage]")) {
    stage.hidden = stage.dataset.fwStage !== id
  }
  // Reflect the active framework on the toggle buttons + the size bars.
  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-fw-toggle]")) {
    const on = btn.dataset.fwToggle === id
    btn.classList.toggle("active", on)
    btn.setAttribute("aria-pressed", on ? "true" : "false")
  }
  for (const bar of document.querySelectorAll<HTMLElement>("[data-fw-bar]")) {
    bar.classList.toggle("active", bar.dataset.fwBar === id)
  }
  void ensureLive(meta, config.data, config.dataGlobal)
}

function init(): void {
  const config = readConfig()
  if (!config) return
  const metaById = new Map(config.frameworks.map((f) => [f.id, f]))

  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-fw-toggle]")) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.fwToggle
      if (id) activate(id, config, metaById)
    })
  }

  // Hydrate the initially-active row on load so the shown framework is live from first paint.
  activate(config.activeId, config, metaById)
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true })
} else {
  init()
}
