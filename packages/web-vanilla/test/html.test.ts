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

  test("arrays flatten in order — the list-rendering idiom", () => {
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
