import { describe, expect, test } from "bun:test"
import { createFormatter, type FormatterOptions, type MessageTree } from "../src/index.ts"
import { type RichChunks, type RichRenderer, renderRich, rich } from "../src/rich.ts"

interface El {
  readonly tag: string
  readonly chunks: RichChunks<El>
}
const el =
  (tag: string) =>
  (chunks: RichChunks<El>): El => ({ tag, chunks })
const tags = { b: el("b"), i: el("i"), link: el("link"), icon: el("icon") }

const fmt = (messages: MessageTree, options?: FormatterOptions<MessageTree>) =>
  createFormatter<MessageTree>("en", messages, options)

describe("rich", () => {
  test("tags in the message's own text call their handlers, nested and in order", () => {
    const t = fmt({ m: "Read the <link>terms and <b>all</b> rules</link> now" })
    expect(rich(t, "m", tags)).toEqual([
      "Read the ",
      { tag: "link", chunks: ["terms and ", { tag: "b", chunks: ["all"] }, " rules"] },
      " now",
    ])
  })

  test("a self-closing tag calls its handler with no content", () => {
    const t = fmt({ m: "a<icon/>b<icon />c" })
    expect(rich(t, "m", tags)).toEqual([
      "a",
      { tag: "icon", chunks: [] },
      "b",
      { tag: "icon", chunks: [] },
      "c",
    ])
  })

  test("interpolated values are text and never open a tag", () => {
    const t = fmt({ m: "Hi <b>{name}</b>" })
    const out = rich(t, "m", tags, { name: "<link>x</link><b>" })
    expect(out).toEqual(["Hi ", { tag: "b", chunks: ["<link>x</link><b>"] }])
  })

  test("a tag without an own handler keeps its content as text and drops its markers", () => {
    const t = fmt({
      m: "<script>alert(1)</script> <constructor>c</constructor> <toString>s</toString> <hasOwnProperty>h</hasOwnProperty>",
    })
    expect(rich(t, "m", tags)).toEqual(["alert(1) c s h"])
    // A name may not start with `_`, so `<__proto__>` is text.
    expect(rich(fmt({ m: "<__proto__>p</__proto__>" }), "m", tags)).toEqual([
      "<__proto__>p</__proto__>",
    ])
  })

  test("a non-function handler is ignored, and an unknown self-closing tag renders nothing", () => {
    const t = fmt({ m: "<b>x</b><hr/>y" })
    // biome-ignore lint/suspicious/noExplicitAny: a malformed handler map from untyped code
    expect(rich(t, "m", { b: "nope" } as any)).toEqual(["xy"])
  })

  test("attributes, spaces and non-names are text, not tags", () => {
    const t = fmt({ m: 'a < b, <3, <a href="x">y</a>, < b>z</ b>, <1>w</1>' })
    expect(rich(t, "m", tags)).toEqual(['a < b, <3, <a href="x">y</a>, < b>z</ b>, <1>w</1>'])
  })

  test("unclosed, stray and crossed markers stay literal text", () => {
    expect(rich(fmt({ m: "Use <b>bold" }), "m", tags)).toEqual(["Use <b>bold"])
    expect(rich(fmt({ m: "x</b>y" }), "m", tags)).toEqual(["x</b>y"])
    expect(rich(fmt({ m: "x</b/>y" }), "m", tags)).toEqual(["x</b/>y"])
    expect(rich(fmt({ m: "<b>1<i>2</b>3</i>" }), "m", tags)).toEqual([
      "<b>1",
      { tag: "i", chunks: ["2</b>3"] },
    ])
    expect(rich(fmt({ m: "<b>x <i>y</i>" }), "m", tags)).toEqual([
      "<b>x ",
      { tag: "i", chunks: ["y"] },
    ])
  })

  test("tags inside plural and select cases, with # as the locale-formatted number", () => {
    const t = fmt({
      m: "{n, plural, one {<b>#</b> item} other {<b>#</b> items}} for {who, select, me {<i>you</i>} other {them}}",
    })
    expect(rich(t, "m", tags, { n: 1200, who: "me" })).toEqual([
      { tag: "b", chunks: ["1,200"] },
      " items for ",
      { tag: "i", chunks: ["you"] },
    ])
  })

  test("deep nesting is handled without recursion", () => {
    const depth = 20_000
    const t = fmt({ m: `${"<b>".repeat(depth)}x${"</b>".repeat(depth)}` })
    let node: string | El | undefined = rich(t, "m", tags)[0]
    let seen = 0
    while (typeof node === "object") {
      seen++
      node = node.chunks[0]
    }
    expect(seen).toBe(depth)
    expect(node).toBe("x")
  })

  test("resolution, fallback and onMissing are the formatter's", () => {
    const missing: string[] = []
    const onMissing = (key: string) => missing.push(key)
    const en = { m: "<b>en</b>", only: "fallback <i>here</i>" }
    const t = fmt({ m: "<b>fr</b>" }, { fallback: [en], onMissing })
    expect(rich(t, "m", tags)).toEqual([{ tag: "b", chunks: ["fr"] }])
    expect(rich(t, "only", tags)).toEqual(["fallback ", { tag: "i", chunks: ["here"] }])
    expect(rich(t, "nope", tags)).toEqual(["nope"])
    expect(missing).toEqual(["nope"])
  })

  test("a malformed ICU message still renders its tags from the raw text", () => {
    const t = fmt({ m: "<b>{broken</b>" })
    expect(rich(t, "m", tags)).toEqual([{ tag: "b", chunks: ["{broken"] }])
  })

  test("a handler may call rich() again", () => {
    const t = fmt({ outer: "a <b>x</b> c <i>y</i>", inner: "<i>in</i>" })
    const out = rich(t, "outer", {
      b: (chunks): El => ({ tag: "b", chunks: [...chunks, ...rich(t, "inner", tags)] }),
      i: el("i"),
    })
    expect(out).toEqual([
      "a ",
      { tag: "b", chunks: ["x", { tag: "i", chunks: ["in"] }] },
      " c ",
      { tag: "i", chunks: ["y"] },
    ])
  })

  test("without tags, rich() text equals t() for every message shape", () => {
    const catalog = {
      plain: "Hello",
      interp: "Hi {name}, {missing}!",
      plural: "{n, plural, =0 {none} one {# item} other {# items}}",
      ordinal: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
      select: "{g, select, f {she} m {he} other {they}} said {n, plural, one {#} other {# times}}",
      nested: "{a, select, x {{n, plural, one {# x} other {# xs}}} other {#}}",
      proto: "{constructor}{toString}",
      malformed: "oops {",
      angle: "a < b > c <3",
    }
    const t = fmt(catalog)
    const vars = { name: "Ada", n: 1234.5, g: "f", a: "x" }
    for (const key of Object.keys(catalog)) {
      expect(rich(t, key, {}, vars).join("")).toBe(t.t(key, vars))
    }
  })

  test("rejects a value that is not a formatter, and a non-object tag map", () => {
    const t = fmt({ m: "x" })
    // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong inputs
    expect(() => rich({ ...t } as any, "m", tags)).toThrow(TypeError)
    // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong inputs
    expect(() => rich(t, "m", null as any)).toThrow(TypeError)
  })
})

describe("renderRich", () => {
  const strings: RichRenderer<string> = {
    join: (chunks) => chunks.join(""),
    lineBreak: () => "\n",
  }

  test("handlers receive one joined node, and <br/> breaks the line by default", () => {
    const t = fmt({ m: "a<br/>b <b>c <i>d</i></b><br>e</br>" })
    const out = renderRich(strings, t, "m", {
      b: (content) => `[${content}]`,
      i: (content) => `(${content})`,
    })
    expect(out).toBe("a\nb [c (d)]\ne")
  })

  test("a br handler replaces the default, and only own handlers are tags", () => {
    const t = fmt({ m: "a<br/>b<toString>s</toString><valueOf>v</valueOf>" })
    const out = renderRich(strings, t, "m", {
      br: () => " | ",
      toString: (content: string) => `{${content}}`,
    })
    expect(out).toBe("a | b{s}v")
  })
})
