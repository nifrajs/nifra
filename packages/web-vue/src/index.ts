import type { DocumentParts, RenderAdapter } from "@nifrajs/web"
/**
 * @nifrajs/web-vue - the Vue render adapter for @nifrajs/web (server side). Streaming SSR via Vue's
 * `renderToWebStream` (a Web `ReadableStream<Uint8Array>`, the seam's native shape); the layout-chain
 * fold is in `./compose`. Client hydration lives in `@nifrajs/web-vue/client`. Uses Vue render functions
 * (`h`), so no SFC compiler / build plugin is needed (contrast `@nifrajs/web-solid`).
 */
import { createSSRApp, defineComponent } from "vue"
import {
  renderToWebStream,
  type SSRContext,
  renderToString as vueRenderToString,
} from "vue/server-renderer"
import { compose } from "./compose.ts"

const ID_TARGET = /^#([A-Za-z][\w-]*)$/

const isDev = (): boolean =>
  typeof process !== "undefined" && process.env?.NODE_ENV !== "production"

const warned = new Set<string>()
const devWarn = (message: string): void => {
  if (!isDev() || warned.has(message)) return
  warned.add(message)
  console.warn(`[nifra] ${message}`)
}

/**
 * Put each `<Teleport>`'s server-rendered content where Vue's hydration looks for it: as the FIRST
 * children of its target. `body` content goes first in `<body>`. An `#id` target the app renders empty
 * gets it spliced in; an `#id` the app does not render gets a container of its own before the app
 * root. Any other target, or an `#id` element that already has children, would hydrate against the
 * wrong nodes, so it renders on the client only.
 */
function placeTeleports(
  html: string,
  teleports: Readonly<Record<string, string>> | undefined,
  parts: DocumentParts | undefined,
): string {
  if (teleports === undefined) return html
  let out = html
  let containers = ""
  for (const [target, content] of Object.entries(teleports)) {
    if (target === "body") {
      if (parts !== undefined) parts.body = content + parts.body
      continue
    }
    const id = ID_TARGET.exec(target)?.[1]
    if (id === undefined) {
      devWarn(
        `<Teleport to="${target}"> renders on the client only: on the server use "body" or "#id".`,
      )
      continue
    }
    // Vue escapes every attribute value, so ` id="x"` is an id attribute and the first `>` ends its tag.
    const open = new RegExp(`<([a-z][\\w-]*)(?:\\s[^>]*)?\\sid="${id}"[^>]*>`).exec(out)
    if (open === null) {
      containers += `<div id="${id}">${content}</div>`
      continue
    }
    const end = open.index + open[0].length
    if (!out.startsWith(`</${open[1]}>`, end)) {
      devWarn(
        `<Teleport to="${target}"> renders on the client only: its target has children of its own.`,
      )
      continue
    }
    out = out.slice(0, end) + content + out.slice(end)
  }
  if (parts !== undefined) parts.body += containers
  return out
}

/** A root SSR app component that renders the composed layout chain. */
const rootApp = (
  chain: readonly unknown[],
  props: Parameters<RenderAdapter["renderToStream"]>[1],
) => createSSRApp(defineComponent({ setup: () => () => compose(chain, props) }))

/** The Vue server render adapter - pass to @nifrajs/web's `renderPage`. */
export const vueAdapter: RenderAdapter = {
  documentParts: true,
  // Synchronous (well, awaited) one-pass render for non-deferred pages (renderPage's buffered fast
  // path). Vue's `renderToString` resolves the same markup as `renderToWebStream` without the stream.
  renderToString(chain, props, options) {
    const context: SSRContext = {}
    return vueRenderToString(rootApp(chain, props), context).then((html) =>
      placeTeleports(html, context.teleports, options?.parts),
    )
  },
  renderToStream(chain, props) {
    // A root component renders the composed chain; createSSRApp + renderToWebStream stream it as a
    // Web ReadableStream (Suspense boundaries stream as they resolve). Teleports are known only once
    // the stream ends, after the document's head and body start were sent.
    const context: SSRContext = {}
    const stream = renderToWebStream(rootApp(chain, props), context)
    if (!isDev()) return stream
    return stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        flush() {
          if (context.teleports !== undefined && Object.keys(context.teleports).length > 0) {
            devWarn("<Teleport> content renders on the client only on a page that defers data.")
          }
        },
      }),
    )
  },
  // Vue hydrates by reconciling against the existing DOM (createSSRApp on the client), so there's
  // no per-document bootstrap script - like React. The seam allows the empty string.
  hydrationHead() {
    return ""
  },
}
