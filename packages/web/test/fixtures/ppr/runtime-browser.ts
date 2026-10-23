/**
 * The PPR runtime in real engines (Chromium, Firefox, WebKit) under a hash-only CSP. Run with
 * `bun packages/web/test/fixtures/ppr/runtime-browser.ts`; exits non-zero on the first failed check.
 */
import assert from "node:assert/strict"
import { type Browser, chromium, firefox, type Page, webkit } from "playwright"
import { encodeHoleFrame, encodeRequestScript } from "../../../src/internal/ppr/frames.ts"
import { PPR_RUNTIME, pprScriptHashes } from "../../../src/internal/ppr/runtime.ts"

declare global {
  interface Window {
    __violations: string[]
    __fills: number
    __nifraPpr: {
      get(name: string): unknown
      leave(): void
      put(name: string, frame: unknown, host: Element | null): void
    }
    __pwnedScript?: unknown
    __pwnedHandler?: unknown
    __tampered?: unknown
  }
}

const HOLES = ["a", "b", "c"] as const
const hashes = (await pprScriptHashes(HOLES)).join(" ")
const BASE_CSP = `default-src 'none'; script-src ${hashes}; connect-src 'self'; img-src 'self'; style-src 'self'`
const TT_CSP = `${BASE_CSP}; require-trusted-types-for 'script'; trusted-types nifra-ppr`

const shell = (holes: readonly string[] = HOLES): string =>
  `<!doctype html><html><head><meta charset="utf-8"><script>${PPR_RUNTIME}</script></head><body><main>${holes
    .map(
      (n) =>
        `<div data-nifra-hole="${n}" aria-busy="true"><p class="fallback">loading ${n}</p></div>`,
    )
    .join("")}</main>`
const frame = (name: string, html: string, props?: unknown): string =>
  encodeHoleFrame(name, props === undefined ? { html } : { html, props }, 256 * 1024)
const request = (token: string): string => encodeRequestScript("/cancel", token, [...HOLES])

const beacons: string[] = []
let release: (() => void) | undefined

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    const html = (body: string, csp = BASE_CSP) =>
      new Response(body, {
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp },
      })
    switch (url.pathname) {
      case "/clean":
      case "/tt":
        return html(
          shell() +
            request("t-clean") +
            frame("a", '<p id="a-ok">A</p>', { n: 1 }) +
            frame("b", '<p id="b-ok">B</p>') +
            frame("a", '<p id="a-dup">dup</p>') +
            frame("c", '<p id="c-ok">C</p>') +
            "</body></html>",
          url.pathname === "/tt" ? TT_CSP : BASE_CSP,
        )
      case "/hostile":
        return html(
          shell() +
            request("t-hostile") +
            frame("a", '<p id="a-ok">A</p><script>window.__pwnedScript=1</script>') +
            frame("b", '<img src="/x.png" onerror="window.__pwnedHandler=1">') +
            '<script>__nifraPpr("c");window.__tampered=1</script>' +
            frame("zzz", "<p>undeclared</p>") +
            "</body></html>",
        )
      case "/stream": {
        const enc = new TextEncoder()
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              enc.encode(shell() + request("t-stream") + frame("a", '<p id="a-ok">A</p>')),
            )
            await gate
            controller.enqueue(enc.encode(`${frame("b", '<p id="b-late">late</p>')}</body></html>`))
            controller.close()
          },
        })
        return new Response(body, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": BASE_CSP,
          },
        })
      }
      case "/cancel":
        beacons.push(await req.text())
        return new Response(null, { status: 204 })
      case "/x.png":
        return new Response("not an image", { status: 404 })
      default:
        return new Response("not found", { status: 404 })
    }
  },
})
const origin = `http://127.0.0.1:${server.port}`

const instrument = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const w = window
    w.__violations = []
    w.__fills = 0
    document.addEventListener("securitypolicyviolation", (e) =>
      w.__violations.push(`${e.effectiveDirective} ${e.blockedURI}`),
    )
    new MutationObserver((records) => {
      for (const r of records)
        if (
          r.target instanceof Element &&
          r.target.hasAttribute("data-nifra-hole") &&
          r.removedNodes.length > 0
        )
          w.__fills++
    }).observe(document, { subtree: true, childList: true })
  })
}

type Report = Record<string, unknown>

async function checkEngine(name: string, browser: Browser): Promise<Report> {
  const report: Report = { engine: name }
  const errors: string[] = []
  const page = await browser.newPage()
  page.on("pageerror", (e) => errors.push(e.message))
  await instrument(page)

  // 1. Clean page: every hole filled exactly once, a duplicate frame ignored, no violations,
  // interactive props readable.
  await page.goto(`${origin}/clean`)
  const clean = await page.evaluate(() => {
    const w = window
    return {
      a: document.querySelector('[data-nifra-hole="a"]')?.innerHTML,
      b: document.querySelector('[data-nifra-hole="b"]')?.innerHTML,
      c: document.querySelector('[data-nifra-hole="c"]')?.innerHTML,
      busy: [...document.querySelectorAll("[data-nifra-hole]")].map((e) =>
        e.getAttribute("aria-busy"),
      ),
      frames: document.querySelectorAll('script[type="application/json"][id^="nifra-ppr:"]').length,
      aProps: w.__nifraPpr.get("a"),
      violations: w.__violations,
      fills: w.__fills,
    }
  })
  assert.equal(clean.a, '<p id="a-ok">A</p>', `${name}: a filled once with the first frame`)
  assert.equal(clean.b, '<p id="b-ok">B</p>')
  assert.equal(clean.c, '<p id="c-ok">C</p>')
  assert.deepEqual(clean.busy, ["false", "false", "false"])
  assert.equal(clean.frames, 0, `${name}: consumed frames are removed`)
  assert.deepEqual(clean.aProps, { props: { n: 1 }, error: false })
  assert.deepEqual(clean.violations, [], `${name}: hash-only CSP admits the runtime and invokers`)
  assert.equal(clean.fills, 3, `${name}: one fill per host`)
  report.clean = "ok"

  // 2. Hostile content: a script inside hole HTML never runs, an inline handler is blocked by the
  // CSP, and an invoker with extra code fails its hash so its hole stays on the fallback.
  await page.goto(`${origin}/hostile`)
  await page.waitForTimeout(200)
  const hostile = await page.evaluate(() => {
    const w = window
    return {
      script: w.__pwnedScript ?? null,
      handler: w.__pwnedHandler ?? null,
      tampered: w.__tampered ?? null,
      c: document.querySelector('[data-nifra-hole="c"]')?.textContent,
      violations: w.__violations.length,
    }
  })
  assert.equal(hostile.script, null, `${name}: <script> in hole HTML must not run`)
  assert.equal(hostile.handler, null, `${name}: inline handler must be blocked by the CSP`)
  assert.equal(hostile.tampered, null)
  assert.equal(
    hostile.c,
    "loading c",
    `${name}: a tampered invoker leaves its hole on the fallback`,
  )
  assert.ok(
    hostile.violations >= 2,
    `${name}: the tampered invoker and the undeclared hole's invoker are both blocked`,
  )
  report.hostile = "ok"

  // 3. Leaving while a hole is pending: the runtime goes dead, the beacon carries this response's
  // token, and a frame that arrives afterwards is ignored.
  beacons.length = 0
  await page.goto(`${origin}/stream`, { waitUntil: "commit" })
  await page.waitForFunction(() => document.querySelector('[data-nifra-hole="a"] #a-ok') !== null)
  await page.evaluate(() => window.__nifraPpr.leave())
  for (let i = 0; i < 50 && beacons.length === 0; i++) await Bun.sleep(20)
  assert.deepEqual(beacons, ["t-stream"], `${name}: one beacon with the response's token`)
  release?.()
  await page.waitForLoadState("load")
  const late = await page.evaluate(
    () => document.querySelector('[data-nifra-hole="b"]')?.textContent,
  )
  assert.equal(late, "loading b", `${name}: no fill after leaving`)
  report.leave = "ok"

  // 4. Trusted Types enforced (engines that implement it): fills still work through the named policy.
  const supportsTT = await page.evaluate(() => "trustedTypes" in window)
  await page.goto(`${origin}/tt`)
  const tt = await page.evaluate(() => {
    const host = (hole: string) => document.querySelector(`[data-nifra-hole="${hole}"]`)
    const main = document.querySelector("main")
    // `put` under the policy reaches only a host of the hole it names.
    window.__nifraPpr.put("a", { html: "<i>stray</i>" }, main)
    window.__nifraPpr.put("a", { html: "<i>stray</i>" }, host("b"))
    window.__nifraPpr.put("b", { html: '<p id="b-put">put</p>' }, host("b"))
    return {
      a: host("a")?.innerHTML,
      b: host("b")?.innerHTML,
      stray: main?.querySelector(":scope > i") !== null,
      violations: window.__violations,
    }
  })
  assert.equal(tt.a, '<p id="a-ok">A</p>', `${name}: fills work with Trusted Types enforced`)
  assert.equal(tt.b, '<p id="b-put">put</p>', `${name}: put refills its own hole's host`)
  assert.equal(tt.stray, false, `${name}: put refuses an element that is not the hole's host`)
  assert.deepEqual(tt.violations, [])
  report.trustedTypes = supportsTT ? "enforced, ok" : "not implemented by engine, ok"

  assert.deepEqual(errors, [], `${name}: no page errors`)
  await page.close()
  return report
}

try {
  for (const [name, type] of [
    ["chromium", chromium],
    ["firefox", firefox],
    ["webkit", webkit],
  ] as const) {
    const browser = await type.launch({ headless: true })
    try {
      console.log(JSON.stringify(await checkEngine(name, browser)))
    } finally {
      await browser.close()
    }
  }
} finally {
  server.stop(true)
}
