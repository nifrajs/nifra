import { describe, expect, test } from "bun:test"
import { html, raw, Template } from "../src/html.ts"

// The security contract first: every interpolation is escaped unless explicitly raw()'d or
// already a Template. These are the assertions that make `html` safe to hand to a product team.

describe("escaping (the security contract)", () => {
  test("script injection in text content is neutralized", () => {
    const evil = '<script>alert("xss")</script>'
    expect(html`<p>${evil}</p>`.html).toBe(
      "<p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>",
    )
  })

  test("attribute breakout via quotes is neutralized", () => {
    const evil = '" onmouseover="alert(1)'
    expect(html`<a title="${evil}">x</a>`.html).toBe(
      '<a title="&quot; onmouseover=&quot;alert(1)">x</a>',
    )
  })

  test("single quotes and ampersands escape too", () => {
    expect(html`<i>${"it's A&B"}</i>`.html).toBe("<i>it&#39;s A&amp;B</i>")
  })

  test("clean strings take the no-alloc fast path unchanged", () => {
    expect(html`<b>${"plain text 123"}</b>`.html).toBe("<b>plain text 123</b>")
  })

  test("raw() is the explicit, greppable opt-out", () => {
    expect(html`<div>${raw("<em>trusted</em>")}</div>`.html).toBe("<div><em>trusted</em></div>")
  })

  test("a nested template is NOT double-escaped", () => {
    const inner = html`<span>${"<safe>"}</span>`
    expect(html`<div>${inner}</div>`.html).toBe("<div><span>&lt;safe&gt;</span></div>")
  })
})

// A value is written for where it lands. Each payload below runs script when HTML-escaping is all
// that stands in its way.
describe("interpolation positions", () => {
  test("an unquoted attribute value is quoted, so a space cannot start another attribute", () => {
    expect(html`<div class=${"x onmouseover=alert(1)"}></div>`.html).toBe(
      '<div class="x onmouseover=alert(1)"></div>',
    )
    expect(html`<div class=a-${"x y"}-b data-x=${'q"r'}>t</div>`.html).toBe(
      '<div class="a-x y-b" data-x="q&quot;r">t</div>',
    )
    expect(html`<i a=${"1"}${"2"} b=${"3"}>t</i>`.html).toBe('<i a="12" b="3">t</i>')
    expect(html`<input value=${"v"}/>`.html).toBe('<input value="v/">')
    expect(html`<img width=${640} height=${480}>`.html).toBe('<img width="640" height="480">')
  })

  test("a script URL that begins a URL attribute is written as about:invalid", () => {
    for (const url of [
      "javascript:alert(1)",
      " \tJavaScript:alert(1)",
      "java\nscript:alert(1)",
      "vbscript:msgbox(1)",
    ])
      expect(html`<a href="${url}">x</a>`.html).toBe('<a href="about:invalid">x</a>')
    expect(html`<a href="${"java"}${"script:alert(1)"}">x</a>`.html).toBe(
      '<a href="about:invalid">x</a>',
    )
    expect(html`<a href="${["java", "script:x"]}">x</a>`.html).toBe('<a href="about:invalid">x</a>')
    expect(html`<form action=${"javascript:alert(1)"}></form>`.html).toBe(
      '<form action="about:invalid"></form>',
    )
    expect(html`<svg><a xlink:href="${"javascript:x"}">x</a></svg>`.html).toBe(
      '<svg><a xlink:href="about:invalid">x</a></svg>',
    )
  })

  test("a URL attribute keeps any other URL, and a scheme after its start is only text", () => {
    expect(html`<a href="${"https://x.example/a?b=1&c=2"}">x</a>`.html).toBe(
      '<a href="https://x.example/a?b=1&amp;c=2">x</a>',
    )
    expect(html`<a href="/s?q=${"javascript:alert(1)"}">x</a>`.html).toBe(
      '<a href="/s?q=javascript:alert(1)">x</a>',
    )
    expect(html`<a href="${"&#106;avascript:alert(1)"}">x</a>`.html).toBe(
      '<a href="&amp;#106;avascript:alert(1)">x</a>',
    )
  })

  test("a string or template throws as a tag name, as script or style code, or as a handler", () => {
    expect(() => html`<${"img src=x onerror=alert(1)"}>`).toThrow("as a tag name")
    expect(() => html`<p>x</${"p"}>`).toThrow("as a tag name")
    for (const run of [
      () => html`<script>f("${"\\"}", "${");alert(1)//"}")</script>`,
      () => html`<SCRIPT>${"x"}</SCRIPT>`,
      () => html`<script src="/a.js"/>${"x"}`,
      () => html`<script>${html`<b>x</b>`}</script>`,
      () => html`<style>a{color:${"red}*{x:y"}}</style>`,
      () => html`<a onclick="go('${"x"}')">x</a>`,
      () => html`<iframe srcdoc="${"<script>alert(1)</script>"}"></iframe>`,
    ])
      expect(run).toThrow("<script> or <style> body")
  })

  test("numbers, booleans and raw() still fill those positions", () => {
    expect(html`<h${2}>t</h${2}>`.html).toBe("<h2>t</h2>")
    expect(html`<script>var n = ${42}</script><p>${"<after>"}</p>`.html).toBe(
      "<script>var n = 42</script><p>&lt;after&gt;</p>",
    )
    expect(html`<a onclick="go(${7})">x</a>`.html).toBe('<a onclick="go(7)">x</a>')
    expect(html`<script type="application/json">${raw('{"a":1}')}</script>`.html).toBe(
      '<script type="application/json">{"a":1}</script>',
    )
  })

  test("an attribute name takes a plain name with no value, or a data- or aria- suffix", () => {
    expect(html`<input ${"checked"} ${""} ${"disabled"}>`.html).toBe("<input checked  disabled>")
    expect(html`<div data-${"role"}="${"a b"}" aria-${"label"}=${"z"}>t</div>`.html).toBe(
      '<div data-role="a b" aria-label="z">t</div>',
    )
    for (const run of [
      () => html`<div ${"onclick=alert(1)"}></div>`,
      () => html`<div ${"onclick"}></div>`,
      () => html`<input ${"value"}="x">`,
      () => html`<a ${"href"}>x</a>`,
      () => html`<a hr${"ef"}="${"javascript:alert(1)"}">x</a>`,
      () => html`<div data-${"x onclick"}="v">t</div>`,
    ])
      expect(run).toThrow("as an attribute name")
  })

  test("a nested template inside an attribute value is escaped as text", () => {
    expect(html`<div title="${html`<b class="k">${"<x>"}</b>`}">t</div>`.html).toBe(
      '<div title="&lt;b class=&quot;k&quot;&gt;&amp;lt;x&amp;gt;&lt;/b&gt;">t</div>',
    )
  })

  test("text after a script, a text-only element or a comment is escaped as text again", () => {
    expect(html`<script>a</script ><p>${"<x>"}</p>`.html).toBe(
      "<script>a</script ><p>&lt;x&gt;</p>",
    )
    expect(html`<script>"</scriptx"; ${1}</script><b>${"<y>"}</b>`.html).toBe(
      '<script>"</scriptx"; 1</script><b>&lt;y&gt;</b>',
    )
    expect(html`<textarea>${"</textarea><script>x</script>"}</textarea>`.html).toBe(
      "<textarea>&lt;/textarea&gt;&lt;script&gt;x&lt;/script&gt;</textarea>",
    )
    expect(html`<!-- ${"-->"} --><!--><!---><p>${"<x>"}</p>`.html).toBe(
      "<!-- --&gt; --><!--><!---><p>&lt;x&gt;</p>",
    )
    expect(html`<!doctype html><p>a < ${"<b>"}</p>`.html).toBe(
      "<!doctype html><p>a < &lt;b&gt;</p>",
    )
  })
})

describe("value rendering", () => {
  test("numbers, bigints, booleans", () => {
    expect(html`${42} ${9n} ${true}`.html).toBe("42 9 true")
  })

  test("null/undefined/false render as nothing (conditional rendering)", () => {
    const show = false
    expect(html`<p>${null}${undefined}${show && html`<b>hidden</b>`}</p>`.html).toBe("<p></p>")
  })

  test("zero renders (the classic && footgun is on the caller, like JSX)", () => {
    expect(html`<p>${0}</p>`.html).toBe("<p>0</p>")
  })

  test("arrays flatten in order - the list-rendering idiom", () => {
    const items = ["a<b", "c"]
    expect(html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`.html).toBe(
      "<ul><li>a&lt;b</li><li>c</li></ul>",
    )
  })

  test("nested arrays flatten recursively", () => {
    expect(html`${[["x", ["y"]], "z"]}`.html).toBe("xyz")
  })

  test("objects throw loudly at the call site, never [object Object]", () => {
    expect(() => html`${{ bad: true } as never}`).toThrow(TypeError)
  })

  test("toString and Template identity", () => {
    const t = html`<p>x</p>`
    expect(t).toBeInstanceOf(Template)
    expect(String(t)).toBe("<p>x</p>")
  })
})
