/**
 * `@nifrajs/i18n/rich` - rich text from a catalog message, without HTML. `rich(formatter, key, tags,
 * vars)` formats the message at `key` exactly as `t()` does, then turns `<name>…</name>` and
 * `<name/>` in the message's own text into calls to `tags[name]`:
 *
 * ```ts
 * // "terms": "Read the <link>terms</link> before {action}."
 * rich(t, "terms", { link: (chunks) => ({ href: "/terms", chunks }) }, { action: "signing up" })
 * // ["Read the ", { href: "/terms", chunks: ["terms"] }, " before signing up."]
 * ```
 *
 * Tags are names only - no attributes, so a translation (from a person, a vendor or a model) decides
 * where emphasis or a link goes, and the handler decides what it is. A tag without an own handler
 * renders its content as text and drops the markers; an unmatched or unclosed marker stays literal
 * text. Interpolated values and `#` are text and are never read for tags, so a value carrying
 * `<link>` cannot open one. Nothing here produces or parses HTML. `t()` is unchanged: it returns the
 * markers as written. The adapters' `rich()` (React, Preact, Solid, Vue) and Svelte's `<Rich>` build on
 * this and render `<br/>` as a line break by default.
 */
import {
  FORMATTER_INTERNALS,
  type Formatter,
  type MessageKey,
  type Part,
  type RegisteredMessages,
  type Runtime,
  readVar,
} from "./format.ts"

/** A tag's content, or a whole rich message: text, and whatever the tag handlers returned, in order.
 * Adjacent text is merged. */
export type RichChunks<R> = readonly (string | R)[]

/** Handlers by tag name. Only own properties count, so `<constructor>` is never `Object.prototype`'s. */
export type RichTags<R> = Readonly<Record<string, (chunks: RichChunks<R>) => R>>

/** How a framework turns rich chunks into one node: {@link renderRich} uses it for every tag's content
 * and for the whole message. */
export interface RichRenderer<N> {
  /** One node for `chunks` (empty for `<name/>`). */
  readonly join: (chunks: RichChunks<N>) => N
  /** The node for `<br/>` when the caller passes no `br` handler. Called once per break, so it may
   * return a fresh element each time. */
  readonly lineBreak: () => N
}

interface Frame<R> {
  readonly name: string
  /** The opening marker as written, restored as text when the tag is never closed. */
  readonly marker: string
  readonly chunks: (string | R)[]
}

// A tag is `<name>`, `</name>` or `<name/>`: an ASCII letter, then letters, digits, `_` or `-`.
// Anything else (`a < b`, `<3`, `<a href="x">`) is text.
const TAG = /<(\/?)([A-Za-z][\w-]*)\s*(\/?)>/y
const EMPTY: Readonly<Record<string, unknown>> = {}

const handlerOf = <R>(
  tags: RichTags<R>,
  name: string,
): ((chunks: RichChunks<R>) => R) | undefined => {
  const handler = Object.hasOwn(tags, name) ? tags[name] : undefined
  return typeof handler === "function" ? handler : undefined
}

const pushText = <R>(chunks: (string | R)[], text: string): void => {
  if (text === "") return
  const last = chunks.length - 1
  const previous = chunks[last]
  if (last >= 0 && typeof previous === "string") chunks[last] = previous + text
  else chunks.push(text)
}

const append = <R>(target: (string | R)[], chunks: RichChunks<R>): void => {
  for (const chunk of chunks) {
    if (typeof chunk === "string") pushText(target, chunk)
    else target.push(chunk)
  }
}

const top = <R>(stack: readonly Frame<R>[]): Frame<R> => stack[stack.length - 1] as Frame<R>

/** Read tags out of one literal run of the message's own text. Iterative: nesting depth is bounded by
 * the explicit stack, never by the call stack. */
function source<R>(text: string, stack: Frame<R>[], tags: RichTags<R>): void {
  let start = 0
  let from = 0
  for (;;) {
    const lt = text.indexOf("<", from)
    if (lt === -1) break
    TAG.lastIndex = lt
    const match = TAG.exec(text)
    if (match === null) {
      from = lt + 1
      continue
    }
    // Read before any handler runs: a handler may call `rich()` again, which reuses `TAG`.
    const end = TAG.lastIndex
    pushText(top(stack).chunks, text.slice(start, lt))
    start = end
    from = end
    const [marker, close, name, self] = match as unknown as [string, string, string, string]
    if (close === "/") {
      const frame = top(stack)
      if (self === "" && stack.length > 1 && frame.name === name) {
        stack.pop()
        const parent = top(stack).chunks
        const handler = handlerOf(tags, name)
        if (handler === undefined) append(parent, frame.chunks)
        else parent.push(handler(frame.chunks))
      } else {
        pushText(frame.chunks, marker)
      }
    } else if (self === "/") {
      const handler = handlerOf(tags, name)
      if (handler !== undefined) top(stack).chunks.push(handler([]))
    } else {
      stack.push({ name, marker, chunks: [] })
    }
  }
  pushText(top(stack).chunks, text.slice(start))
}

// Mirrors `evaluate()` in format.ts case for case (the parity test holds them together), emitting
// into the tag stack instead of a string.
function emit<R>(
  parts: readonly Part[],
  vars: Readonly<Record<string, unknown>>,
  rt: Runtime,
  pound: number | undefined,
  stack: Frame<R>[],
  tags: RichTags<R>,
): void {
  for (const part of parts) {
    if (typeof part === "string") {
      source(part, stack, tags)
    } else if (part.kind === "interp") {
      const value = readVar(vars, part.arg)
      pushText(top(stack).chunks, value === undefined || value === null ? "" : String(value))
    } else if (part.kind === "pound") {
      pushText(top(stack).chunks, pound === undefined ? "#" : rt.number(pound))
    } else if (part.kind === "select") {
      const cat = String(readVar(vars, part.arg))
      emit(part.cases.get(cat) ?? part.cases.get("other") ?? [], vars, rt, pound, stack, tags)
    } else {
      const n = Number(readVar(vars, part.arg))
      let cat = part.exact ? `=${n}` : ""
      if (!part.cases.has(cat)) cat = rt.category(part.kind, n)
      emit(part.cases.get(cat) ?? part.cases.get("other") ?? [], vars, rt, n, stack, tags)
    }
  }
}

/**
 * The message at `key` as rich chunks: text, and what `tags` returned for each tag in it. Resolution,
 * `fallback` catalogs, `onMissing` and number formatting are the formatter's, as for `t()`; a key no
 * catalog has returns `[key]`.
 */
export function rich<R, M extends object = RegisteredMessages>(
  formatter: Formatter<M>,
  key: MessageKey<M>,
  tags: RichTags<R>,
  vars: Readonly<Record<string, unknown>> = EMPTY,
): (string | R)[] {
  const internals = FORMATTER_INTERNALS.get(formatter)
  if (internals === undefined) throw new TypeError("rich: formatter must come from createFormatter")
  if (tags === null || typeof tags !== "object") throw new TypeError("rich: tags must be an object")
  const path = String(key)
  const ast = internals.resolve(path)
  if (ast === undefined) return [path]
  const root: Frame<R> = { name: "", marker: "", chunks: [] }
  const stack: Frame<R>[] = [root]
  emit(ast, vars, internals.runtime, undefined, stack, tags)
  // An unclosed tag was text all along: restore its marker and keep its content in place.
  while (stack.length > 1) {
    const frame = stack.pop() as Frame<R>
    const parent = top(stack).chunks
    pushText(parent, frame.marker)
    append(parent, frame.chunks)
  }
  return root.chunks
}

/**
 * {@link rich} for a UI framework: each handler receives its tag's content as one node (`renderer.join`)
 * and the result is one node, with `<br/>` rendered by `renderer.lineBreak` unless `tags.br` is given.
 * The adapters' `rich()` is this with their own renderer.
 */
export function renderRich<N, M extends object = RegisteredMessages>(
  renderer: RichRenderer<N>,
  formatter: Formatter<M>,
  key: MessageKey<M>,
  tags: Readonly<Record<string, (content: N) => N>> = EMPTY as Readonly<
    Record<string, (content: N) => N>
  >,
  vars?: Readonly<Record<string, unknown>>,
): N {
  if (tags === null || typeof tags !== "object") throw new TypeError("rich: tags must be an object")
  // Null prototype: a handler named `__proto__` stays an ordinary own entry.
  const handlers: Record<string, (chunks: RichChunks<N>) => N> = Object.create(null)
  // `<br/>`; a `<br>…</br>` pair keeps its content after the break rather than losing it.
  handlers.br = (chunks) =>
    chunks.length === 0 ? renderer.lineBreak() : renderer.join([renderer.lineBreak(), ...chunks])
  for (const name of Object.keys(tags)) {
    const handler = tags[name]
    if (typeof handler === "function") handlers[name] = (chunks) => handler(renderer.join(chunks))
  }
  return renderer.join(rich(formatter, key, handlers, vars))
}
