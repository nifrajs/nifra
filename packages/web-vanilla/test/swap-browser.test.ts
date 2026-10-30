import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createWebApp, type Manifest, rawHref, redirect } from "@nifrajs/web"
import {
  CHROME_LAUNCH_TIMEOUT_MS,
  type ChromePage,
  findChrome,
  launchChrome,
} from "../../cli/test/headless-chrome.ts"
import { html, raw, slot, type VanillaComponent, vanillaAdapter } from "../src/index.ts"

/**
 * `@nifrajs/web/islands/swap` against a real server and a real browser: the vanilla page answers a
 * swap with one slot, and the client puts it in place, mounts its islands and keeps history. Skipped
 * without a Chrome locally; CI must have one.
 */
const chrome = findChrome()
if (chrome === undefined && process.env.CI !== undefined) {
  throw new Error("swap-browser needs Chrome in CI: set NIFRA_TEST_CHROME to its binary")
}

const HOTELS = ["Ritz", "Savoy", "Claridge's", "Dorchester", "Langham"]
const PAGE_SIZE = 2

let cart = 0
let notes = 0
// A request for `q=held` waits here until the test lets it go.
let held: {
  readonly arrived: PromiseWithResolvers<Request>
  readonly go: PromiseWithResolvers<void>
}
const hold = () => {
  held = { arrived: Promise.withResolvers(), go: Promise.withResolvers() }
}
hold()

const Layout: VanillaComponent = ({ children }) =>
  html`<main id="app">${children}</main><aside data-swap-slot="cart">${slot("cart", html`<b>${cart}</b>`)}</aside>`

const Hotels: VanillaComponent = (props) => {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the loader below returns this shape
  const { q, page } = props.data as { readonly q: string; readonly page: number }
  const found = HOTELS.filter((name) => name.includes(q))
  const rows = found.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const more =
    found.length > (page + 1) * PAGE_SIZE
      ? html`<li data-island="more"><a id="more" href="/hotels?q=${q}&page=${page + 1}" data-swap="append:results">More</a></li>`
      : ""
  return html`<form id="search" action="/hotels" method="" data-swap="replace:results"><input name="q" value="${q}"><button>Go</button></form>
    <a id="ritz" href="/hotels?q=Ritz" data-swap="replace:results">Ritz</a>
    <a id="held" href="/hotels?q=held" data-swap="replace:results">Held</a>
    <a id="blank" href="/hotels?q=Savoy" target="_blank" data-swap="replace:results">New tab</a>
    <a id="away" href="/about" data-swap="replace:results">About</a>
    <a id="moved" href="/old" data-swap="replace:results">Old</a>
    <form id="add" method="post" action="/hotels" data-swap="replace:cart"><button name="add" value="1">Add</button></form>
    <form id="note" method="post" action="/note" data-swap="replace:results"><button>Note</button></form>
    <div data-island-ignore><a id="ignored" href="/hotels?q=Savoy" data-swap="replace:results">Ignored</a></div>
    <ul data-swap-slot="results">${slot("results", [
      ...rows.map((name) => html`<li data-island="row">${name}</li>`),
      more,
    ])}</ul>`
}

const Note: VanillaComponent = (props) =>
  html`<main id="app"><h1 id="saved">Saved ${String(props.actionData ?? "nothing")}</h1><ul><li data-island="row">Note</li></ul>${raw('<img src="data:," onerror="window.__unsafe = true">')}</main>`

const manifest = (): Manifest => ({
  routes: [
    {
      id: "hotels",
      pattern: "/hotels",
      layoutIds: ["_layout"],
      file: "hotels.ts",
      load: async () => ({
        default: Hotels,
        hydrate: false,
        islandScripts: ["/swap.js"],
        loader: async (ctx) => {
          const params = new URL(ctx.request.url).searchParams
          const q = params.get("q") ?? ""
          if (q === "held") {
            held.arrived.resolve(ctx.request)
            await held.go.promise
          }
          return { q, page: Number(params.get("page") ?? "0") }
        },
        action: async () => {
          cart++
          return redirect(rawHref("/hotels"))
        },
      }),
    },
    {
      id: "about",
      pattern: "/about",
      layoutIds: [],
      file: "about.ts",
      load: async () => ({ default: () => html`<h1>About</h1>`, hydrate: false }),
    },
    {
      // Its page has no results slot, so it answers a swap whole.
      id: "note",
      pattern: "/note",
      layoutIds: [],
      file: "note.ts",
      load: async () => ({
        default: Note,
        hydrate: false,
        islandScripts: ["/note.js"],
        action: async () => {
          notes++
          return notes
        },
      }),
    },
    {
      id: "old",
      pattern: "/old",
      layoutIds: [],
      file: "old.ts",
      load: async () => ({
        default: () => html``,
        loader: () => redirect(rawHref("/hotels?q=Savoy")),
      }),
    },
  ],
  layouts: { _layout: { file: "_layout.ts", load: async () => ({ default: Layout }) } },
})

// Each island in a slot logs its mount and unmount, so a test sees which ones the swap replaced.
const ENTRY = `import { defineIsland } from ${JSON.stringify(fileURLToPath(new URL("../../web/src/islands.ts", import.meta.url)))}
import { enableSwap } from ${JSON.stringify(fileURLToPath(new URL("../../web/src/islands-swap.ts", import.meta.url)))}
window.__log = []
window.__moreActive = 0
const row = defineIsland((el) => {
  const name = el.textContent
  window.__log.push("mount " + name)
  return () => window.__log.push("unmount " + name)
})
// \`?scoped\` scopes the swaps to the layout's \`#app\` element instead of the document.
const app = location.search.includes("scoped") ? document.getElementById("app") : null
const more = defineIsland(() => {
  window.__moreActive++
  return () => window.__moreActive--
})
window.__stop = enableSwap({ row, more }, app ? { root: app } : {})
`

const NOTE_ENTRY = `import { mountIslands } from ${JSON.stringify(fileURLToPath(new URL("../../web/src/islands.ts", import.meta.url)))}
window.__log = []
window.__stop = mountIslands({ row: (el) => {
  window.__log.push("mount " + el.textContent)
  return () => window.__log.push("unmount " + el.textContent)
} })
window.__noteStarted = true
`

let page: ChromePage | undefined
let server: ReturnType<typeof Bun.serve> | undefined
let dir: string | undefined
const requests: string[] = []
const origin = (): string => `http://127.0.0.1:${server?.port}`

beforeAll(async () => {
  if (chrome === undefined) return
  dir = mkdtempSync(join(tmpdir(), "swap-browser-"))
  writeFileSync(join(dir, "entry.js"), ENTRY)
  const built = await Bun.build({ entrypoints: [join(dir, "entry.js")], target: "browser" })
  if (!built.success) throw new AggregateError(built.logs, "the swap entry did not build")
  const bundle = await built.outputs[0]!.text()
  writeFileSync(join(dir, "note.js"), NOTE_ENTRY)
  const note = await Bun.build({ entrypoints: [join(dir, "note.js")], target: "browser" })
  if (!note.success) throw new AggregateError(note.logs, "the note entry did not build")
  const noteBundle = await note.outputs[0]!.text()
  // No page here hydrates, so the client entry is never requested.
  const app = createWebApp({ adapter: vanillaAdapter, manifest: manifest(), clientEntry: "/c.js" })
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 404 })
      if (url.pathname === "/swap.js")
        return new Response(bundle, { headers: { "content-type": "text/javascript" } })
      if (url.pathname === "/note.js")
        return new Response(noteBundle, { headers: { "content-type": "text/javascript" } })
      requests.push(
        `${request.method} ${url.pathname}${url.search} ${request.headers.get("x-nifra-swap") ?? "-"}`,
      )
      const response = await app.fetch(request)
      if (url.pathname === "/note")
        response.headers.set("content-security-policy", "script-src 'self'")
      if (url.searchParams.has("policy"))
        return new Response(
          `${await response.text()}<img src="data:," onerror="window.__unsafe = true">`,
          {
            status: response.status,
            headers: {
              ...Object.fromEntries(response.headers),
              "content-security-policy": "script-src 'self'",
            },
          },
        )
      if (url.searchParams.has("cached"))
        response.headers.set("cache-control", "public, max-age=3600")
      // Model an already-cached document from before the swap runtime was deployed.
      if (url.searchParams.has("cached") && request.headers.get("x-nifra-swap") === null)
        response.headers.delete("vary")
      if (!url.searchParams.has("tt")) return response
      // A document that enforces Trusted Types, with no policy to let HTML through.
      const headers = new Headers(response.headers)
      headers.append("content-security-policy", "require-trusted-types-for 'script'")
      return new Response(response.body, { status: response.status, headers })
    },
  })
  page = await launchChrome(chrome)
}, CHROME_LAUNCH_TIMEOUT_MS)
afterAll(async () => {
  await page?.close()
  server?.stop(true)
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
}, 30_000)

// The driver's waits stop at the first page error, so a stray one would fail every later test.
afterEach(() => {
  expect(page?.errors ?? []).toEqual([])
})

/** `waitFor` across a full load: a poll that lands on the page being torn down is tried again. */
async function waitAcrossLoad(p: ChromePage, expression: string): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      return await p.waitFor(expression, 1_000)
    } catch (error) {
      if (p.errors.length > 0 || Date.now() > deadline) throw error
    }
  }
}

/** Load `/hotels`, wait for the islands, and mark the document so a full load shows as a lost mark. */
async function open(path = "/hotels"): Promise<ChromePage> {
  await page!.goto(`${origin()}${path}`)
  await page!.waitFor("window.__stop !== undefined")
  await page!.evaluate("window.__same = true")
  requests.length = 0
  return page!
}

const rows = (p: ChromePage) =>
  p.evaluate<string[]>(
    `[...document.querySelectorAll("[data-swap-slot=results] li")].map((li) => li.textContent)`,
  )
const path = (p: ChromePage) => p.evaluate<string>("location.pathname + location.search")
const swappedIn = (p: ChromePage) => p.evaluate<boolean>("window.__same === true")

test.skipIf(chrome === undefined)(
  "a form GET swaps the slot in one request, pushes its URL and remounts the slot's islands",
  async () => {
    const p = await open()
    expect(await p.evaluate<string[]>("window.__log")).toEqual(["mount Ritz", "mount Savoy"])
    const length = await p.evaluate<number>("history.length")
    await p.evaluate(
      `document.querySelector("#search input").value = "a"; document.getElementById("search").requestSubmit()`,
    )
    await p.waitFor(`location.search === "?q=a"`)
    expect(await rows(p)).toEqual(["Savoy", "Claridge's", "More"])
    expect(await swappedIn(p)).toBe(true)
    expect(requests).toEqual(["GET /hotels?q=a results"])
    expect(await p.evaluate<number>("history.length")).toBe(length + 1)
    expect(await p.evaluate<string[]>("window.__log.slice(2)")).toEqual([
      "unmount Ritz",
      "unmount Savoy",
      "mount Savoy",
      "mount Claridge's",
    ])
    expect(
      await p.evaluate<boolean>(
        `document.querySelector("[data-swap-slot=results]").hasAttribute("aria-busy")`,
      ),
    ).toBe(false)
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "back and forward fetch the slot again for the URL they reach",
  async () => {
    const p = await open()
    await p.evaluate(`document.getElementById("ritz").click()`)
    await p.waitFor(`location.search === "?q=Ritz"`)
    expect(await rows(p)).toEqual(["Ritz"])
    await p.evaluate("history.back()")
    await p.waitFor(`document.querySelectorAll("[data-swap-slot=results] li").length === 3`)
    expect(await path(p)).toBe("/hotels")
    expect(await rows(p)).toEqual(["Ritz", "Savoy", "More"])
    await p.evaluate("history.forward()")
    await p.waitFor(`document.querySelectorAll("[data-swap-slot=results] li").length === 1`)
    expect(await rows(p)).toEqual(["Ritz"])
    expect(await swappedIn(p)).toBe(true)
    expect(requests).toEqual([
      "GET /hotels?q=Ritz results",
      "GET /hotels results",
      "GET /hotels?q=Ritz results",
    ])
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "append adds the next page in place of the spent More link, keeps the URL and keeps focus in the slot",
  async () => {
    const p = await open()
    await p.evaluate(
      `document.getElementById("more").focus(); document.getElementById("more").click()`,
    )
    await p.waitFor(`document.querySelectorAll("[data-swap-slot=results] li").length === 5`)
    expect(await rows(p)).toEqual(["Ritz", "Savoy", "Claridge's", "Dorchester", "More"])
    expect(await path(p)).toBe("/hotels")
    expect(await p.evaluate<string>("document.activeElement.dataset.swapSlot")).toBe("results")
    expect(await p.evaluate<string[]>("window.__log.slice(2)")).toEqual([
      "mount Claridge's",
      "mount Dorchester",
    ])
    expect(requests).toEqual(["GET /hotels?q=&page=1 results"])
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "append disposes spent islands while retaining earlier rows",
  async () => {
    const p = await open()
    expect(await p.evaluate<number>("window.__moreActive")).toBe(1)
    await p.evaluate('document.getElementById("more").click()')
    await p.waitFor('document.querySelectorAll("[data-swap-slot=results] li").length === 5')
    expect(await p.evaluate<number>("window.__moreActive")).toBe(1)
    await p.evaluate('document.getElementById("more").click()')
    await p.waitFor('document.getElementById("more") === null')
    expect(await p.evaluate<number>("window.__moreActive")).toBe(0)
    expect(await p.evaluate<string[]>("window.__log")).not.toContain("unmount Ritz")
    await p.evaluate("window.__stop()")
    expect(await p.evaluate<string[]>("window.__log")).toContain("unmount Ritz")
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "a swap bypasses an already cached full document without Vary",
  async () => {
    const p = await open("/hotels?cached=1")
    await p.evaluate(
      `document.getElementById("ritz").href = location.href; document.getElementById("ritz").click()`,
    )
    await p.waitFor(
      "document.querySelector('[data-swap-slot=results]').hasAttribute('aria-busy') === false",
    )
    // A second round trip lets a cached-document fallback finish if one was incorrectly scheduled.
    await p.evaluate('fetch("/swap.js").then((r) => r.text())')
    expect(await swappedIn(p)).toBe(true)
    expect(requests).toEqual(["GET /hotels?cached=1 results"])
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "a page under CSP swaps in one request, and its own policy governs the slot",
  async () => {
    const p = await open("/hotels?policy=1")
    // A capture listener on the document sees the slot's image error just before its own handler.
    await p.evaluate(`document.addEventListener("error", (event) => {
      if (event.target instanceof HTMLImageElement && event.target.closest("[data-swap-slot]"))
        window.__slotImageFailed = true
    }, true)`)
    await p.evaluate(
      `document.getElementById("ritz").href = "/hotels?policy=1&q=Ritz"; document.getElementById("ritz").click()`,
    )
    await p.waitFor("window.__slotImageFailed === true")
    expect(await swappedIn(p)).toBe(true)
    expect(await rows(p)).toEqual(["Ritz"])
    expect(await p.evaluate<boolean>("window.__unsafe === true")).toBe(false)
    expect(requests).toEqual(["GET /hotels?policy=1&q=Ritz results"])
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "a POST uses native navigation and follows its redirect without posting twice",
  async () => {
    const p = await open()
    const before = cart
    await p.evaluate(`document.querySelector("#add button").click()`)
    await waitAcrossLoad(
      p,
      `document.querySelector("[data-swap-slot=cart]")?.textContent === "${before + 1}" && window.__stop !== undefined`,
    )
    expect(cart).toBe(before + 1)
    expect(await path(p)).toBe("/hotels")
    expect(await swappedIn(p)).toBe(false)
    expect(requests).toEqual(["POST /hotels -", "GET /hotels -"])
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "a POST document runs its own entry, enforces its CSP and submits exactly once",
  async () => {
    const p = await open()
    const before = notes
    await p.evaluate(`document.querySelector("#note button").click()`)
    await waitAcrossLoad(
      p,
      `document.getElementById("saved")?.textContent === "Saved ${before + 1}" && window.__noteStarted === true`,
    )
    expect(notes).toBe(before + 1)
    expect(await path(p)).toBe("/note")
    expect(await swappedIn(p)).toBe(false)
    expect(requests).toEqual(["POST /note -"])
    expect(await p.evaluate<boolean>("window.__unsafe === true")).toBe(false)
    expect(await p.evaluate<string[]>("window.__log")).toContain("mount Note")
    await p.evaluate("history.back()")
    await waitAcrossLoad(p, `location.pathname === "/hotels" && window.__stop !== undefined`)
    expect(await rows(p)).toEqual(["Ritz", "Savoy", "More"])
    expect(notes).toBe(before + 1)
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "a scoped swap root also leaves POST startup to the destination document",
  async () => {
    const p = await open("/hotels?scoped=1")
    await p.evaluate(`document.querySelector("#note button").click()`)
    await waitAcrossLoad(p, "window.__noteStarted === true")
    expect(await swappedIn(p)).toBe(false)
    expect(await p.evaluate<string[]>("window.__log")).toContain("mount Note")
    await p.evaluate("window.__stop()")
    expect(await p.evaluate<string[]>("window.__log")).toContain("unmount Note")
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "a newer swap of the same slot cancels the older one",
  async () => {
    hold()
    const p = await open()
    await p.evaluate(`document.getElementById("held").click()`)
    const first = await held.arrived.promise
    const cancelled = new Promise<void>((resolve) =>
      first.signal.addEventListener("abort", () => resolve()),
    )
    await p.evaluate(`document.getElementById("ritz").click()`)
    await p.waitFor(`location.search === "?q=Ritz"`)
    await cancelled
    held.go.resolve()
    // One more round trip, so a late answer to the cancelled request would have landed by now.
    await p.evaluate(`fetch("/swap.js").then((r) => r.text())`)
    expect(await rows(p)).toEqual(["Ritz"])
    expect(await path(p)).toBe("/hotels?q=Ritz")
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "a failed request leaves the page and marks the link",
  async () => {
    const p = await open()
    await p.evaluate(
      `window.fetch = () => Promise.reject(new TypeError("offline")); document.getElementById("ritz").click()`,
    )
    await p.waitFor(`document.getElementById("ritz").hasAttribute("data-swap-error")`)
    expect(await rows(p)).toEqual(["Ritz", "Savoy", "More"])
    expect(await path(p)).toBe("/hotels")
    expect(
      await p.evaluate<boolean>(
        `document.querySelector("[data-swap-slot=results]").hasAttribute("aria-busy")`,
      ),
    ).toBe(false)
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "a page without the slot and a redirect both load normally",
  async () => {
    let p = await open()
    await p.evaluate(`document.getElementById("away").click()`)
    await waitAcrossLoad(p, `location.pathname === "/about" && document.readyState === "complete"`)
    expect(await swappedIn(p)).toBe(false)
    expect(await p.evaluate<string>(`document.querySelector("h1").textContent`)).toBe("About")

    p = await open()
    await p.evaluate(`document.getElementById("moved").click()`)
    await waitAcrossLoad(p, `location.search === "?q=Savoy" && window.__stop !== undefined`)
    expect(await swappedIn(p)).toBe(false)
    expect(await rows(p)).toEqual(["Savoy"])
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "a page that refuses the HTML under Trusted Types loads the URL instead",
  async () => {
    const p = await open("/hotels?tt=1")
    const refused = await p.evaluate<boolean>(`(() => {
      try {
        document.createElement("template").innerHTML = "<b></b>"
        return false
      } catch {
        return true
      }
    })()`)
    expect(refused).toBe(true)
    await p.evaluate(`document.getElementById("ritz").click()`)
    await waitAcrossLoad(p, `location.search === "?q=Ritz" && window.__stop !== undefined`)
    expect(await swappedIn(p)).toBe(false)
    expect(await rows(p)).toEqual(["Ritz"])
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "modifier clicks, other targets and ignore regions are left to the browser",
  async () => {
    const p = await open()
    const handled = (id: string, init: string) =>
      p.evaluate<boolean>(`(() => {
        let prevented
        addEventListener("click", (event) => { prevented = event.defaultPrevented; event.preventDefault() }, { once: true })
        document.getElementById(${JSON.stringify(id)}).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ${init} }))
        return prevented
      })()`)
    expect(await handled("ritz", "ctrlKey: true")).toBe(false)
    expect(await handled("ritz", "metaKey: true")).toBe(false)
    expect(await handled("ritz", "button: 1")).toBe(false)
    expect(await handled("blank", "")).toBe(false)
    expect(await handled("ignored", "")).toBe(false)
    expect(await handled("ritz", "")).toBe(true)
  },
  30_000,
)
