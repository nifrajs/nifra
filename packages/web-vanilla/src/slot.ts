import { type HtmlValue, html, Template } from "./html.ts"

// The slot a swap render is answering for. A vanilla render runs synchronously from start to end,
// so this is set only while one render runs and never seen by another request.
let wanted: { readonly name: string; found?: string } | undefined

/**
 * A region of the page that a `data-swap` link or form refreshes on its own. Place it as the only
 * content of the element marked `data-swap-slot="<name>"`:
 *
 *   html`<ul data-swap-slot="results">${slot("results", rows)}</ul>`
 *
 * It renders `content` unchanged. When the server answers a swap request for `name`, the page runs
 * as usual and the response is this slot's HTML alone, so the fragment is always a slice of the
 * real page and cannot drift from it.
 */
export function slot(name: string, content: HtmlValue): Template {
  const out = content instanceof Template ? content : html`${content}`
  if (wanted !== undefined && wanted.name === name && wanted.found === undefined)
    wanted.found = out.html
  return out
}

/** Run `render` and return the HTML of the first `slot(name, ...)` it produced, if any. */
export function captureSlot(name: string, render: () => unknown): string | undefined {
  const outer = wanted
  const target: { readonly name: string; found?: string } = { name }
  wanted = target
  try {
    render()
  } finally {
    wanted = outer
  }
  return target.found
}
