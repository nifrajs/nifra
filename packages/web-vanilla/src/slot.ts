import { type HtmlValue, html, Template } from "./html.ts"
import { templateSlots } from "./template-slots.ts"

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
  const template = new Template(out.html)
  templateSlots.set(template, [
    { name, start: 0, end: out.html.length },
    ...(templateSlots.get(out) ?? []),
  ])
  return template
}

/** Return the first named slot that survives in the final composed output. */
export function captureSlot(name: string, render: () => Template): string | undefined {
  const out = render()
  const range = templateSlots.get(out)?.find((entry) => entry.name === name)
  return range === undefined ? undefined : out.html.slice(range.start, range.end)
}
