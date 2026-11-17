import { expect, test } from "bun:test"
import { Tokenizer } from "parse5"
import { createElement, Fragment, type ReactNode, Suspense } from "react"
import { validateComponentHTML } from "../src/server-components/html.ts"
import { type ScannedTag, scanComponentHTML } from "../src/server-components/html-scan.ts"

// This program has no `react-dom` types; a non-literal specifier keeps it out of the type graph.
const REACT_DOM_SERVER = "react-dom/server"
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: react-dom/server exports renderToString with this signature.
const { renderToString } = (await import(REACT_DOM_SERVER)) as {
  renderToString(node: ReactNode): string
}

/** parse5's reading of `html`: its start tags, and whether it reported anything at all. */
function tokenized(html: string): { tags: ScannedTag[]; clean: boolean } {
  const tags: ScannedTag[] = []
  let clean = true
  const dirty = () => {
    clean = false
  }
  new Tokenizer(
    { sourceCodeLocationInfo: false },
    {
      onStartTag(token) {
        tags.push({
          tagName: token.tagName,
          attrs: token.attrs.map(({ name, value }) => ({ name, value })),
        })
      },
      onEndTag() {},
      onComment() {},
      onEof() {},
      onCharacter() {},
      onWhitespaceCharacter() {},
      onNullCharacter: dirty,
      onDoctype: dirty,
      onParseError: dirty,
    },
  ).write(html, true)
  return { tags, clean }
}

const ch = (...codes: number[]): string => String.fromCharCode(...codes)

const PIECES = [
  "<div>",
  "</div>",
  '<p class="a b">',
  '<a href="/x?a=1&amp;b=2">',
  '<img src="/a.png" alt="&quot;x&quot; &#39;y&#x27;"/>',
  '<B ID="Q" Data-X="1">',
  "<a b=c>",
  "<a b='c'>",
  '<a b = "c">',
  '<a b= "c">',
  '<a b="c"d="e">',
  '<a b="c" b="d">',
  '<a b="c" B="d">',
  "<a b>",
  "<a b/>",
  "<a/b>",
  "<a / >",
  '<a b="\r\n">',
  '<a b="&nbsp;&lt;&gt;&amp;">',
  '<a b="&copy;&amp">',
  '<a b="&copy;">',
  '<a b="&lt;!--&#39;">',
  '<a :x="1" @y="2" x.y="3" _z="4" xlink:href="#q">',
  '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>',
  "</a >",
  "</a/>",
  "</ a>",
  "</>",
  "</a b>",
  "<?x?>",
  "<!>",
  "<!$>",
  "<!DOCTYPE html>",
  "<![CDATA[x]]>",
  "<!x>",
  "<!---->",
  "<!--->",
  "<!-->",
  "<!--$-->",
  "<!--/$-->",
  "<!--$!-->",
  "<!--[-->",
  "<!--[!-->",
  "<!--]-->",
  "<!-- -->",
  "<!--a--!>",
  "<!--a--!-->",
  "<!--<!--x-->",
  "<!--<!-->",
  "<!--a<b-->",
  "<!--a--->",
  "<!---a-->",
  "<!----!>",
  "<!--",
  "-->",
  "--!>",
  "<title>",
  "<textarea>",
  "&amp;",
  "&lt;",
  "&nbsp;",
  "&#39;",
  "&#x27;",
  "&#X27;",
  "&copy;",
  "&ampx",
  "&amp",
  "& ",
  "&#0;",
  "&#x110000;",
  "<",
  ">",
  '"',
  "'",
  "=",
  "/",
  "!",
  "-",
  " ",
  "\t",
  "\n",
  "\r",
  "\r\n",
  "\f",
  "\0",
  "\x01",
  "\x1f",
  "\x7f",
  "\x85",
  ch(0xa0),
  ch(0xfdd0),
  ch(0xfdef),
  ch(0xfffd),
  ch(0xfffe),
  ch(0xffff),
  ch(0xd800),
  ch(0xdc00),
  ch(0xd83d, 0xde00),
  ch(0xd83f, 0xdffe),
  ch(0xdbff, 0xdfff),
  ch(0x65, 0x301),
  "x",
  "A",
  "<a ",
  'href="',
  '">',
  "b=",
  '="',
  "/>",
]

const ALPHABET = [
  ..."<>/!-\"'=&;#xaB1 \t\n\r\0:._".split(""),
  ch(0x85),
  ch(0xfffe),
  ch(0xd800),
  ch(0xdc00),
]

function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

function corpus(): string[] {
  const random = seeded(20261021)
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)]
    if (item === undefined) throw new Error("pick from an empty list")
    return item
  }
  const strings = [...PIECES]
  for (let index = 0; index < 20000; index++) {
    let html = ""
    const count = 1 + Math.floor(random() * 10)
    for (let piece = 0; piece < count; piece++) html += pick(PIECES)
    strings.push(html)
  }
  for (let index = 0; index < 20000; index++) {
    let html = ""
    const length = Math.floor(random() * 20)
    for (let unit = 0; unit < length; unit++) html += pick(ALPHABET)
    strings.push(html)
  }
  return strings
}

function rendered(): string[] {
  const text = `a < b & "c" 'd' ${ch(0xa0)} ${ch(0xd83d, 0xde00)} </p><script>x</script>`
  const tree = createElement(
    "section",
    { className: "card", "data-id": 'q"1', style: { color: "red" }, "aria-label": text },
    createElement("h2", null, text, " ", 3),
    createElement("img", { src: "/a.png?x=1&y=2", alt: text }),
    createElement("input", { type: "checkbox", defaultChecked: true, disabled: true }),
    createElement("a", { href: "/p/1" }, "Item ", 1, " of ", 2),
    createElement(
      "svg",
      { viewBox: "0 0 1 1" },
      createElement("path", { d: "M0 0", strokeWidth: 2 }),
    ),
    createElement(Suspense, { fallback: "..." }, createElement(Fragment, null, "in", "side")),
  )
  return [renderToString(tree), renderToString(createElement("p", null, text))]
}

test("the scan reads only HTML that parse5 reads cleanly, with the same start tags", () => {
  let accepted = 0
  for (const html of [...corpus(), ...rendered()]) {
    const tags = scanComponentHTML(html)
    if (tags === undefined) continue
    accepted++
    const reference = tokenized(html)
    if (!reference.clean || JSON.stringify(reference.tags) !== JSON.stringify(tags))
      throw new Error(`scan and tokenizer differ on ${JSON.stringify(html)}`)
  }
  // Mostly random strings: the share only shows the scan is not trivially refusing everything.
  expect(accepted).toBeGreaterThan(5000)
})

test("the scan reads renderer output, so the validator's common case skips the tokenizer", () => {
  for (const html of rendered()) expect(scanComponentHTML(html)).toBeDefined()
  for (const html of [
    "<!--[--><p>a</p><!--[!--><p>b</p><!--]--><!---->",
    '<div class="x"><!--$--><span>1</span><!--/$--><!-- --></div>',
  ])
    expect(scanComponentHTML(html)).toBeDefined()
})

// Elements an array search visits, over every method that can search one. A search that grows with
// the attributes already read makes the total grow with the square of the attribute count.
function arraySearchVisits(run: () => void): number {
  const methods = [
    "some",
    "every",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "includes",
    "indexOf",
    "lastIndexOf",
    "filter",
  ]
  let visits = 0
  const originals = methods.map((method) => Reflect.get(Array.prototype, method))
  for (const [index, method] of methods.entries()) {
    const original = originals[index]
    Reflect.set(Array.prototype, method, function (this: unknown[], ...args: unknown[]) {
      visits += this.length
      return Reflect.apply(original, this, args)
    })
  }
  try {
    run()
  } finally {
    for (const [index, method] of methods.entries()) {
      Reflect.set(Array.prototype, method, originals[index])
    }
  }
  return visits
}

const manyAttributes = (count: number): string =>
  `<div ${Array.from({ length: count }, (_, index) => `data-k${index}="x"`).join(" ")}></div>`

test("the work to check attribute names does not grow with the square of the attribute count", () => {
  let tags: ScannedTag[] | undefined
  const small = arraySearchVisits(() => scanComponentHTML(manyAttributes(1000)))
  const large = arraySearchVisits(() => {
    tags = scanComponentHTML(manyAttributes(4000))
  })
  expect(tags?.[0]?.attrs).toHaveLength(4000)
  // The scan searches an array only for the first few attributes, so the visits stay put as the count
  // grows; a search of every earlier attribute is sixteen times as much for four times the attributes.
  expect(large).toBeLessThanOrEqual(small * 2 + 64)
  expect(() => validateComponentHTML(manyAttributes(4000))).not.toThrow()
})

test("attribute names are unique without case, and each tag owns its names", () => {
  expect(scanComponentHTML('<div data-a="1" DATA-A="2">')).toBeUndefined()
  const prefix = Array.from({ length: 8 }, (_, index) => `data-k${index}="x"`).join(" ")
  expect(scanComponentHTML(`<div ${prefix} DATA-K0="duplicate">`)).toBeUndefined()
  expect(scanComponentHTML('<i id="1"></i><b ID="2"></b>')).toEqual([
    { tagName: "i", attrs: [{ name: "id", value: "1" }] },
    { tagName: "b", attrs: [{ name: "id", value: "2" }] },
  ])
})

test("the validator refuses the same strings with and without the scan", () => {
  const outcome = (run: () => void): string => {
    try {
      run()
      return "ok"
    } catch (error) {
      return error instanceof Error ? `${error.name}:${String(Reflect.get(error, "code"))}` : "?"
    }
  }
  const random = seeded(7)
  const policy = [
    '<a href="javascript:x">',
    '<a href="java&#x09;script:x">',
    '<img onerror="x">',
    "<script>",
    "<iframe>",
    '<p style="background:url(x)">',
    '<a srcdoc="x">',
    '<link rel="stylesheet" href="/a.css">',
    '<a href="/ok">',
    '<p style="color:red">',
  ]
  for (let index = 0; index < 4000; index++) {
    const html = `${policy[Math.floor(random() * policy.length)]}${PIECES[Math.floor(random() * PIECES.length)]}`
    const viaScan = outcome(() => validateComponentHTML(html))
    // The scan refuses a leading `<!>`, which the tokenizer reads as an empty comment.
    const viaTokenizer = outcome(() => validateComponentHTML(`<!>${html}`))
    if (scanComponentHTML(html) !== undefined && viaScan !== viaTokenizer)
      throw new Error(`${JSON.stringify(html)}: ${viaScan} vs ${viaTokenizer}`)
  }
})
