import { expect, test } from "bun:test"
import {
  defer,
  type RenderAdapter,
  type RenderStreamOptions,
  renderPageResult,
} from "../src/index.ts"

const HEAD = `<meta name="robots" content="noindex">`
const BODY = `<!--teleport start anchor--><dialog>hi</dialog><!--teleport anchor-->`

const oneChunk = (html: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(html))
      c.close()
    },
  })

function adapterWith(documentParts: boolean, seen: Array<RenderStreamOptions | undefined>) {
  const fill = (options: RenderStreamOptions | undefined) => {
    seen.push(options)
    if (options?.parts !== undefined) {
      options.parts.head += HEAD
      options.parts.body += BODY
    }
  }
  const adapter: RenderAdapter = {
    hydrationHead: () => "",
    renderToString: (_chain, _props, options) => {
      fill(options)
      return "<main>app</main>"
    },
    renderToStream: (_chain, _props, options) => {
      fill(options)
      return oneChunk("<main>app</main>")
    },
    documentParts,
  }
  return adapter
}

const render = async (adapter: RenderAdapter, data: unknown, extra: { nonce?: string } = {}) =>
  (
    await renderPageResult({
      adapter,
      chain: [() => null],
      data,
      clientEntry: "/client.js",
      routeId: "index",
      title: "parts",
      ...extra,
    })
  )
    .toResponse()
    .text()

const placed = (html: string) => {
  const head = html.slice(0, html.indexOf("</head>"))
  expect(head).toContain(HEAD)
  expect(html).toContain(`<body>${BODY}<div id="root">`)
  expect(html.indexOf("<main>app</main>")).toBeGreaterThan(html.indexOf(BODY))
}

test("an adapter's head and body parts land in <head> and before the root, buffered or streamed", async () => {
  const seen: Array<RenderStreamOptions | undefined> = []
  const adapter = adapterWith(true, seen)
  placed(await render(adapter, { n: 1 }))
  placed(await render(adapter, { slow: defer(Promise.resolve(1)) }))
  placed(await render(adapter, { n: 1 }, { nonce: "N0NCE" }))
  expect(seen.map((options) => options?.nonce)).toEqual([undefined, undefined, "N0NCE"])
})

test("an adapter without documentParts is not handed parts and renders the plain shell", async () => {
  const seen: Array<RenderStreamOptions | undefined> = []
  const html = await render(adapterWith(false, seen), { n: 1 })
  expect(seen).toEqual([undefined])
  expect(html).toContain(`</head><body><div id="root">`)
  expect(html).not.toContain(HEAD)
})
