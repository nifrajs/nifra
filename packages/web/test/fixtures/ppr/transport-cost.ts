/**
 * Hole transport cost for large holes: `<template>` moved by script vs HTML as a JSON string set
 * through innerHTML, with full escaping (`serializeData`) or light escaping (`</` and `<!--` only).
 * Reports document bytes (raw and gzip) and when the hole is filled, measured from navigation start,
 * median over runs, in Chromium, Firefox and WebKit. Run: `bun .../transport-cost.ts`.
 */
import { gzipSync } from "node:zlib"
import { chromium, firefox, webkit } from "playwright"
import { serializeData } from "../../../src/internal/render-document.ts"

declare global {
  interface Window {
    __filled?: number
  }
}

const RUNS = Number(process.env.RUNS ?? "15")
const SIZES_KB = [10, 100, 500]

const holeHtml = (kb: number): string => {
  let html = '<ul class="results">'
  for (let i = 0; html.length < kb * 1024; i++) {
    html += `<li class="item" data-id="${i}"><a href="/p/${i}"><img src="/img/${i}.png" alt="Product ${i}" width="64" height="64"></a><h3>Product ${i}</h3><p class="desc">A sturdy thing &amp; a fine gift, item ${i}.</p><span class="price">$${i}.99</span><button type="button" class="add">Add</button></li>`
  }
  return `${html}</ul>`
}

const lightJson = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll("</", "<\\/")
    .replaceAll("<!--", "<\\u0021--")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029")

const TEMPLATE_RUNTIME =
  'window.__t=function(){var s=document.currentScript,t=s.previousElementSibling;s.remove();t.remove();var h=document.querySelector("[data-hole]");h.replaceChildren(t.content);window.__filled=performance.now()}'
const JSON_RUNTIME =
  'window.__j=function(){var s=document.currentScript,j=s.previousElementSibling;s.remove();j.remove();var v=JSON.parse(j.textContent);var h=document.querySelector("[data-hole]");h.innerHTML=v.html;window.__filled=performance.now()}'

const shell = `<!doctype html><html><head><meta charset="utf-8"><script>${TEMPLATE_RUNTIME};${JSON_RUNTIME}</script></head><body><main><h1>Shell</h1><div data-hole><p>loading</p></div></main>`

type Transport = "template" | "json-full" | "json-light"
const documentFor = (transport: Transport, kb: number): string => {
  const html = holeHtml(kb)
  const frame =
    transport === "template"
      ? `<template>${html}</template><script>__t()</script>`
      : `<script type="application/json">${transport === "json-full" ? serializeData({ html }) : lightJson({ html })}</script><script>__j()</script>`
  return `${shell}${frame}</body></html>`
}

const documents = new Map<string, string>()
for (const kb of SIZES_KB)
  for (const transport of ["template", "json-full", "json-light"] as const)
    documents.set(`/${transport}/${kb}`, documentFor(transport, kb))

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const body = documents.get(new URL(req.url).pathname)
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })
  },
})
const origin = `http://127.0.0.1:${server.port}`

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

console.log("| size | transport | bytes raw | bytes gzip |")
console.log("|---|---|---|---|")
for (const kb of SIZES_KB) {
  for (const transport of ["template", "json-full", "json-light"] as const) {
    const doc = documents.get(`/${transport}/${kb}`) ?? ""
    console.log(`| ${kb} KB | ${transport} | ${Buffer.byteLength(doc)} | ${gzipSync(doc).length} |`)
  }
}

console.log(
  `\n| engine | size | template | json-full | json-light |  (fill time from navigation start, median of ${RUNS})`,
)
console.log("|---|---|---|---|---|")
try {
  for (const [name, type] of [
    ["chromium", chromium],
    ["firefox", firefox],
    ["webkit", webkit],
  ] as const) {
    const browser = await type.launch({ headless: true })
    try {
      const page = await browser.newPage()
      for (const kb of SIZES_KB) {
        const times: Record<Transport, number[]> = {
          template: [],
          "json-full": [],
          "json-light": [],
        }
        for (let run = 0; run < RUNS + 2; run++) {
          // Interleaved, so drift hits every transport alike; the first two rounds warm up.
          for (const transport of ["template", "json-full", "json-light"] as const) {
            await page.goto(`${origin}/${transport}/${kb}`)
            const filled = await page.evaluate(() => window.__filled)
            if (filled === undefined)
              throw new Error(`${name} ${transport} ${kb}: hole never filled`)
            if (run >= 2) times[transport].push(filled)
          }
        }
        console.log(
          `| ${name} | ${kb} KB | ${median(times.template).toFixed(1)} ms | ${median(times["json-full"]).toFixed(1)} ms | ${median(times["json-light"]).toFixed(1)} ms |`,
        )
      }
    } finally {
      await browser.close()
    }
  }
} finally {
  server.stop(true)
}
