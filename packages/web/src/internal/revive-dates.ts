/**
 * `t.date()` across the wire, browser half: every place the browser parses page data rebuilds the
 * `{ "__nifra_date": iso }` tags the server's `WireDate` wrote into `Date`s. Kept apart from
 * `wire-date.ts` so client bundles never carry the server class.
 */

export const DATE_TAG = "__nifra_date"
const TAGGED = `"${DATE_TAG}"`

// A JSON.parse reviver runs leaves first and defines each result as an own property, so a key named
// `__proto__` never becomes the prototype.
const revive = (_key: string, value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value
  const tagged: unknown = Reflect.get(value, DATE_TAG)
  return typeof tagged === "string" && Object.keys(value).length === 1 ? new Date(tagged) : value
}

/** `JSON.parse` that rebuilds every `{ "__nifra_date": iso }` into a `Date`, when the text has one. */
export const parsePageData = (text: string): unknown =>
  text.includes(TAGGED) ? JSON.parse(text, revive) : JSON.parse(text)

/**
 * {@link parsePageData}'s reviver as source declaring `__nifraDates`, for client code nifra generates rather than
 * bundles (server-function stubs; `DEFERRED_RUNTIME` carries the same text). A literal with nothing
 * interpolated: Bun keeps a template that interpolates an import, and with it every string built from
 * it, in client bundles that never use them.
 */
export const REVIVE_DATES_SOURCE = `const __nifraDates = (d) => {
  if (!d || typeof d !== "object") return d
  if (Array.isArray(d)) { for (let i = 0; i < d.length; i++) d[i] = __nifraDates(d[i]); return d }
  const k = Object.keys(d)
  if (k.length === 1 && k[0] === "__nifra_date" && typeof d.__nifra_date === "string") return new Date(d.__nifra_date)
  for (const x of k) { const v = __nifraDates(d[x]); if (v !== d[x]) Object.defineProperty(d, x, { value: v, enumerable: true, writable: true, configurable: true }) }
  return d
}`
