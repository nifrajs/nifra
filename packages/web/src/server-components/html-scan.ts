/**
 * A linear scan of the HTML a component renderer writes, for the validator's common case. It reads
 * only a subset that parse5's tokenizer reads without a parse error and with the same start tags:
 * ASCII tag and attribute names, double-quoted values, a few character references and plain
 * comments. Anything else returns `undefined`, and the tokenizer decides. A differential test holds
 * the two to the same tags (server-components-html-scan.test.ts).
 */

export interface ScannedTag {
  readonly tagName: string
  readonly attrs: { readonly name: string; readonly value: string }[]
}

const REFERENCES: ReadonlyArray<readonly [string, string]> = [
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&#x27;", "'"],
  ["&nbsp;", "\u00a0"],
]

const referenceAt = (html: string, at: number): readonly [string, string] | undefined => {
  for (const reference of REFERENCES) if (html.startsWith(reference[0], at)) return reference
  return undefined
}

const isSpace = (code: number): boolean =>
  code === 0x20 || code === 0x0a || code === 0x09 || code === 0x0c || code === 0x0d
const isLetter = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a)
const isTagCode = (code: number): boolean =>
  isLetter(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d
const isAttributeStart = (code: number): boolean => isLetter(code) || code === 0x5f || code === 0x3a
const isAttributeCode = (code: number): boolean =>
  isAttributeStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x2e

/**
 * The code units of the character at `at`, or 0 when parse5 reports it (NULL, a control, a
 * noncharacter, a lone surrogate) or past the end.
 */
function unitsAt(html: string, at: number): number {
  const code = html.charCodeAt(at)
  if (code >= 0x20 && code < 0x7f) return 1
  if (code >= 0xd800 && code <= 0xdbff) {
    const low = html.charCodeAt(at + 1)
    if (!(low >= 0xdc00 && low <= 0xdfff)) return 0
    const point = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000
    return (point & 0xfffe) === 0xfffe ? 0 : 2
  }
  if (Number.isNaN(code) || (code >= 0xdc00 && code <= 0xdfff)) return 0
  if (code < 0x20) return isSpace(code) ? 1 : 0
  if (code <= 0x9f) return 0
  return (code >= 0xfdd0 && code <= 0xfdef) || code === 0xfffe || code === 0xffff ? 0 : 1
}

/** Where a start tag whose name begins at `at` ends, with `tags` given its tag, or -1. */
function scanStartTag(html: string, at: number, tags: ScannedTag[]): number {
  let end = at
  while (isTagCode(html.charCodeAt(end))) end++
  const tagName = html.slice(at, end).toLowerCase()
  // The validator reads these two as a browser does, which needs the text after them.
  if (tagName === "title" || tagName === "textarea") return -1
  let code = html.charCodeAt(end)
  if (!(isSpace(code) || code === 0x2f || code === 0x3e)) return -1
  const attrs: { name: string; value: string }[] = []
  for (;;) {
    while (isSpace(html.charCodeAt(end))) end++
    code = html.charCodeAt(end)
    if (code === 0x3e || (code === 0x2f && html.charCodeAt(end + 1) === 0x3e)) {
      tags.push({ tagName, attrs })
      return end + (code === 0x3e ? 1 : 2)
    }
    if (!isAttributeStart(code)) return -1
    const nameStart = end
    while (isAttributeCode(html.charCodeAt(end))) end++
    const name = html.slice(nameStart, end).toLowerCase()
    if (attrs.some((attr) => attr.name === name)) return -1
    code = html.charCodeAt(end)
    let value = ""
    if (code === 0x3d) {
      if (html.charCodeAt(end + 1) !== 0x22) return -1
      let from = end + 2
      end = from
      for (;;) {
        code = html.charCodeAt(end)
        if (code === 0x22) break
        if (code === 0x26) {
          const reference = referenceAt(html, end)
          if (reference === undefined) return -1
          value += html.slice(from, end) + reference[1]
          end += reference[0].length
          from = end
          continue
        }
        // A CR would reach the tokenizer's value as LF.
        const units = code === 0x0d ? 0 : unitsAt(html, end)
        if (units === 0) return -1
        end += units
      }
      value += html.slice(from, end)
      end++
      code = html.charCodeAt(end)
      if (!(isSpace(code) || code === 0x2f || code === 0x3e)) return -1
    } else if (!(isSpace(code) || code === 0x2f || code === 0x3e)) return -1
    attrs.push({ name, value })
  }
}

/** The start tags of `html`, or `undefined` when it leaves the subset this scan reads. */
export function scanComponentHTML(html: string): ScannedTag[] | undefined {
  const tags: ScannedTag[] = []
  let at = 0
  while (at < html.length) {
    const code = html.charCodeAt(at)
    if (code === 0x3c) {
      const next = html.charCodeAt(at + 1)
      if (isLetter(next)) {
        at = scanStartTag(html, at + 1, tags)
        if (at === -1) return undefined
      } else if (next === 0x2f) {
        let end = at + 2
        if (!isLetter(html.charCodeAt(end))) return undefined
        while (isTagCode(html.charCodeAt(end))) end++
        while (isSpace(html.charCodeAt(end))) end++
        if (html.charCodeAt(end) !== 0x3e) return undefined
        at = end + 1
      } else if (html.startsWith("!--", at + 1)) {
        const from = at + 4
        if (html.charCodeAt(from) === 0x3e || html.startsWith("->", from)) return undefined
        const close = html.indexOf("-->", from)
        if (close === -1) return undefined
        for (let inner = from; inner < close; ) {
          const units = unitsAt(html, inner)
          if (units === 0) return undefined
          // `<!` can open a nested comment and `--!` a `--!>` ending; both are parse errors.
          if (
            html.charCodeAt(inner) === 0x21 &&
            ((inner > from && html.charCodeAt(inner - 1) === 0x3c) ||
              (inner - 2 >= from && html.startsWith("--", inner - 2)))
          )
            return undefined
          inner += units
        }
        at = close + 3
      } else return undefined
    } else if (code === 0x26) {
      const reference = referenceAt(html, at)
      if (reference === undefined) return undefined
      at += reference[0].length
    } else {
      const units = unitsAt(html, at)
      if (units === 0) return undefined
      at += units
    }
  }
  return tags
}
