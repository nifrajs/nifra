import { Glob } from "bun"
import { IGNORED } from "../check-scan.ts"
import { toPosix } from "./posix-path.ts"

/**
 * A reader for the markup of a `.vue` or `.svelte` file. The source index holds only a component's
 * script blocks, so a rule that judges what a template renders reads the raw file with this.
 */

export interface HtmlComment {
  readonly start: number
  /** Where the text after `<!--` stops: before the closing delimiter. */
  readonly bodyEnd: number
  readonly end: number
}

// A comment ends at `-->` or `--!>`.
const COMMENT_END = /--!?>/g

/** The comment opened at `start`, which HTML ends at `-->` or `--!>`; `<!-->` and `<!--->` are empty. */
function commentAt(text: string, start: number): HtmlComment {
  const body = start + 4
  if (text.startsWith(">", body)) return { start, bodyEnd: body, end: body + 1 }
  if (text.startsWith("->", body)) return { start, bodyEnd: body, end: body + 2 }
  COMMENT_END.lastIndex = body
  const close = COMMENT_END.exec(text)
  return close === null
    ? { start, bodyEnd: text.length, end: text.length }
    : { start, bodyEnd: close.index, end: close.index + close[0].length }
}

/** The end of a markup tag or `{expression}`, ignoring `>`/braces inside quoted values. */
function markupEnd(text: string, start: number, expression = false): number {
  let quote: string | undefined
  let braces = expression ? 1 : 0
  for (let at = start; at < text.length; at++) {
    const char = text[at]
    if (quote !== undefined) {
      if (braces > 0 && char === "\\") at++
      else if (char === quote) quote = undefined
    } else if (char === '"' || char === "'" || (braces > 0 && char === "`")) quote = char
    else if (char === "{") braces++
    else if (char === "}") {
      braces--
      if (expression && braces === 0) return at + 1
    } else if (!expression && braces === 0 && char === ">") return at + 1
  }
  return text.length
}

/** An opening tag of a template, from {@link scanTemplate}. */
export interface TemplateTag {
  /** The tag name, lowercased. */
  readonly name: string
  /** The tag name as written: a component is capitalised, an intrinsic element is not. */
  readonly written: string
  /** The offset of the `<`. */
  readonly at: number
  /** The offset just after the tag name, where its attributes start. */
  readonly attributesAt: number
  /** Whether the tag is markup: always for Svelte, and for Vue inside a `<template>`. */
  readonly inTemplate: boolean
}

export interface TemplateScan {
  readonly tags: readonly TemplateTag[]
  /**
   * The file with its HTML comments turned into `//` lines and every other character blanked, line
   * counts unchanged, for the shared `nifra-expect` reader. A marker in quoted text suppresses nothing.
   */
  readonly expectationLines: readonly string[]
}

/** The opening tags of `text`, not those inside a script or style block, an HTML comment or an expression. */
export function scanTemplate(text: string, vue: boolean): TemplateScan {
  const tags: TemplateTag[] = []
  const comments: HtmlComment[] = []
  let templateDepth = 0
  for (let at = 0; at < text.length; ) {
    if (text.startsWith("<!--", at)) {
      const comment = commentAt(text, at)
      comments.push(comment)
      at = comment.end
      continue
    }
    if (text[at] === "{" && (!vue || text.startsWith("{{", at))) {
      at = markupEnd(text, at + 1, true)
      continue
    }
    if (text[at] !== "<") {
      at++
      continue
    }
    const tag = /^<(\/?)([\w-]+)(?=[\s/>])/.exec(text.slice(at))
    if (tag === null) {
      at++
      continue
    }
    const tagAt = at
    const end = markupEnd(text, at + tag[0].length)
    const name = tag[2]?.toLowerCase() ?? ""
    const closing = tag[1] === "/"
    at = end
    if (!closing && (name === "script" || name === "style")) {
      const close = name === "script" ? /<\/script\s*>/gi : /<\/style\s*>/gi
      close.lastIndex = end
      const match = close.exec(text)
      at = match === null ? text.length : close.lastIndex
      continue
    }
    if (name === "template") templateDepth += closing ? -1 : 1
    if (closing) continue
    tags.push({
      name,
      written: tag[2] ?? name,
      at: tagAt,
      attributesAt: tagAt + tag[0].length,
      inTemplate: !vue || templateDepth > 0,
    })
  }
  // Adapt only real HTML comments to the shared directive parser. Non-comment code stays a block
  // boundary. Line counts are unchanged.
  const code = (part: string): string => part.replace(/[^\s]/g, "x")
  let expectations = ""
  let previous = 0
  for (const comment of comments) {
    expectations += code(text.slice(previous, comment.start))
    expectations += text
      .slice(comment.start + 4, comment.bodyEnd)
      .split("\n")
      .map((line) => `// ${line}`)
      .join("\n")
    previous = comment.end
  }
  expectations += code(text.slice(previous))
  return { tags, expectationLines: expectations.split("\n") }
}

/** One attribute of a template tag, as written. */
export interface TemplateAttribute {
  readonly name: string
  /** The offset of the attribute's name. */
  readonly at: number
  /** The text between the quotes of `name="…"` or `name='…'`. */
  readonly quoted: string | undefined
  /** The string of `name={"…"}`, `name={'…'}` or a template literal in braces. */
  readonly braceString: string | undefined
  /** What stands between the braces of any other `name={…}`. */
  readonly braced: string | undefined
  /** The value of `name=value`. */
  readonly bare: string | undefined
}

const SPACE = /\s/
const NAME_END = /[\s=>/]/
const STRING_IN_BRACES = /^(?:"([^"]*)"|'([^']*)'|`([^`]*)`)$/

/**
 * The attributes of `tag`, up to the first thing that is not one (`>` or `/>`). A value is read as
 * `name="x"`, `name='x'`, `name={…}` (balanced, so `on:click={() => {}}` is one attribute) or an
 * unquoted `name=x`; a Svelte `{...props}` or `{id}` is an attribute named by its braces.
 */
export function readAttributes(text: string, tag: TemplateTag): TemplateAttribute[] {
  const attributes: TemplateAttribute[] = []
  const skipSpace = (from: number): number => {
    let at = from
    while (at < text.length && SPACE.test(text[at] ?? "")) at++
    return at
  }
  let at = tag.attributesAt
  for (;;) {
    const start = skipSpace(at)
    if (start === at || start >= text.length) break
    const first = text[start]
    if (first === ">" || first === "/" || first === "=") break
    let end = start
    if (first === "{") end = markupEnd(text, start + 1, true)
    else while (end < text.length && !NAME_END.test(text[end] ?? "")) end++
    const name = text.slice(start, end)
    at = end
    let quoted: string | undefined
    let braceString: string | undefined
    let braced: string | undefined
    let bare: string | undefined
    const equals = skipSpace(end)
    if (text[equals] === "=") {
      const value = skipSpace(equals + 1)
      const open = text[value]
      if (open === '"' || open === "'") {
        const close = text.indexOf(open, value + 1)
        const stop = close === -1 ? text.length : close
        quoted = text.slice(value + 1, stop)
        at = Math.min(stop + 1, text.length)
      } else if (open === "{") {
        const stop = markupEnd(text, value + 1, true)
        const inner = text.slice(value + 1, Math.max(value + 1, stop - 1))
        const literal = STRING_IN_BRACES.exec(inner.trim())
        if (literal === null) braced = inner
        else braceString = literal[1] ?? literal[2] ?? literal[3]
        at = stop
      } else {
        let stop = value
        while (stop < text.length && !/[\s"'<>`{}]/.test(text[stop] ?? "")) stop++
        if (stop > value) bare = text.slice(value, stop)
        at = Math.max(stop, equals + 1)
      }
    }
    attributes.push({ name, at: start, quoted, braceString, braced, bare })
  }
  return attributes
}

/** The 1-based line of an offset in `text`: a search over the line starts, so a file with thousands of links is not re-split for each. */
export function lineLookup(text: string): (offset: number) => number {
  const starts = [0]
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1)
  return (offset) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if ((starts[mid] ?? 0) <= offset) low = mid
      else high = mid - 1
    }
    return low + 1
  }
}

const TEST_DIR = /(?:^|\/)(?:tests?|__tests__)\//

/** The `.vue` and `.svelte` files under `root` that a lint reads, sorted, as `/` paths. */
export async function templateFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for await (const entry of new Glob("**/*.{vue,svelte}").scan({ cwd: root, dot: false })) {
    // Bun yields `\` paths on Windows, which IGNORED and TEST_DIR (and the reported location) expect as `/`.
    const file = toPosix(entry)
    if (!IGNORED.test(file) && !TEST_DIR.test(file)) files.push(file)
  }
  return files.sort()
}
