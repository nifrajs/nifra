import { describe, expect, test } from "bun:test"
import * as parse5 from "parse5"
import {
  assertHoleName,
  encodeHoleFrame,
  encodeRequestScript,
  injectHoleFallbacks,
  validateHoleHtml,
} from "../src/internal/ppr/frames.ts"
import { holeInvoker, PPR_RUNTIME, pprScriptHashes } from "../src/internal/ppr/runtime.ts"

type Node5 = {
  nodeName: string
  attrs?: Array<{ name: string; value: string }>
  childNodes?: Node5[]
  value?: string
}

/** Every element under `node`, in document order, as an HTML parser built them. */
const elements = (node: Node5): Array<Node5 & { attrs: Array<{ name: string; value: string }> }> =>
  (node.childNodes ?? []).flatMap((child) =>
    child.attrs === undefined ? [] : [{ ...child, attrs: child.attrs }, ...elements(child)],
  )
const textOf = (node: Node5 | undefined): string =>
  (node?.childNodes ?? []).map((child) => child.value ?? "").join("")

/** The JSON text of the one inert frame in `html`, parsed as a browser's `JSON.parse` would. */
const frameJson = (html: string): unknown => {
  const match =
    /<script type="application\/json" id="nifra-ppr:[a-z0-9-]+">([\s\S]*?)<\/script>/.exec(html)
  if (match?.[1] === undefined) throw new Error(`no frame in ${html}`)
  return JSON.parse(match[1])
}

describe("PPR hole frames", () => {
  test("a frame is an inert JSON script then the constant invoker", () => {
    const frame = encodeHoleFrame("cart", { html: "<p>2 items</p>", props: { count: 2 } }, 4096)
    expect(frame).toBe(
      '<script type="application/json" id="nifra-ppr:cart">{"v":1,"html":"<p>2 items<\\/p>","props":{"count":2}}</script><script>__nifraPpr("cart")</script>',
    )
    expect(frameJson(frame)).toEqual({ v: 1, html: "<p>2 items</p>", props: { count: 2 } })
  })

  test("a non-interactive hole sends no props key at all", () => {
    expect(frameJson(encodeHoleFrame("greeting", { html: "<b>Hi</b>" }, 4096))).toEqual({
      v: 1,
      html: "<b>Hi</b>",
    })
  })

  test("an error frame carries the error slot and nothing else", () => {
    expect(
      frameJson(encodeHoleFrame("cart", { error: true, html: "<p>Unavailable</p>" }, 4096)),
    ).toEqual({ v: 1, error: true, html: "<p>Unavailable</p>" })
  })

  test("nothing in the HTML or props can close the script element or open a comment", () => {
    for (const hostile of [
      "</script><script>alert(1)</script>",
      "</SCRIPT ><img src=x onerror=alert(1)>",
      "</script\t/>",
      "<!--<script></script>--></script>",
      "<!-- </template> \u2028\u2029",
    ]) {
      const frame = encodeHoleFrame("cart", { html: hostile, props: { note: hostile } }, 4096)
      const body = parse5.parse(`<!doctype html><html><head></head><body>${frame}</body></html>`)
      const scripts = elements(body).filter((node) => node.nodeName === "script")
      expect(scripts.map((node) => node.attrs.map((a) => `${a.name}=${a.value}`))).toEqual([
        ["type=application/json", "id=nifra-ppr:cart"],
        [],
      ])
      expect(elements(body).map((node) => node.nodeName)).toEqual([
        "html",
        "head",
        "body",
        "script",
        "script",
      ])
      expect(JSON.parse(textOf(scripts[0]))).toEqual({
        v: 1,
        html: hostile,
        props: { note: hostile },
      })
      expect(textOf(scripts[1])).toBe('__nifraPpr("cart")')
    }
  })

  test("a frame over the byte limit throws, counting UTF-8 bytes rather than string length", () => {
    const ascii = encodeHoleFrame("cart", { html: "x" }, 4096)
    expect(() => encodeHoleFrame("cart", { html: "x" }, ascii.length - 1)).toThrow(
      'hole "cart" frame exceeds',
    )
    expect(encodeHoleFrame("cart", { html: "x" }, ascii.length)).toBe(ascii)
    // Twenty three-byte characters: under the limit by length, over it by bytes.
    const wide = encodeHoleFrame("cart", { html: "€".repeat(20) }, 4096)
    expect(() => encodeHoleFrame("cart", { html: "€".repeat(20) }, wide.length + 10)).toThrow(
      RangeError,
    )
  })

  test("hole names are narrow enough to be ids, attribute values and hashed scripts", () => {
    for (const name of ["cart", "a", "recs-2", "x".repeat(32)])
      expect(() => assertHoleName(name)).not.toThrow()
    for (const name of ["", "Cart", "2cart", "cart_x", "c art", 'c"', "x".repeat(33), "-a"]) {
      expect(() => assertHoleName(name)).toThrow("must match")
    }
  })

  test("the request script is inert JSON with the token, never executable", () => {
    const script = encodeRequestScript("/__nifra/ppr/cancel", "t0k", ["cart", "greeting"])
    expect(script).toBe(
      '<script type="application/json" id="nifra-ppr-req">{"cancel":"/__nifra/ppr/cancel","token":"t0k","holes":["cart","greeting"]}</script>',
    )
  })
})

describe("hole HTML validation (I12)", () => {
  test("ordinary framework output passes", () => {
    expect(() =>
      validateHoleHtml(
        '<section class="cart"><h2>Cart</h2><ul><li>Tea &amp; cake</li></ul><a href="/checkout">Pay</a><img src="/a.png" alt=""><button type="button">+</button></section>',
      ),
    ).not.toThrow()
  })

  test("anything that runs script or escapes the host is refused", () => {
    for (const html of [
      "<script>alert(1)</script>",
      '<img src="x" onerror="alert(1)">',
      '<a href="javascript:alert(1)">x</a>',
      '<iframe src="/x"></iframe>',
      "<template><p>x</p></template>",
      "<style>body{display:none}</style>",
      '<base href="https://evil.test/">',
      '<div style="background:url(javascript:alert(1))"></div>',
    ]) {
      expect(() => validateHoleHtml(html)).toThrow()
    }
  })
})

describe("shell fallbacks (I5)", () => {
  const shell =
    '<main><h1>Tea</h1><div data-nifra-hole="cart" aria-busy="true"></div><aside><div data-nifra-hole="recs" aria-busy="true"></div></aside></main>'

  test("each fallback goes into its empty host", () => {
    expect(
      injectHoleFallbacks(
        shell,
        new Map([
          ["recs", "<p>Loading picks</p>"],
          ["cart", "<p>Loading cart</p>"],
        ]),
      ),
    ).toBe(
      '<main><h1>Tea</h1><div data-nifra-hole="cart" aria-busy="true"><p>Loading cart</p></div><aside><div data-nifra-hole="recs" aria-busy="true"><p>Loading picks</p></div></aside></main>',
    )
  })

  test("a missing, duplicated or non-empty host fails the shell build", () => {
    expect(() => injectHoleFallbacks(shell, new Map([["greeting", ""]]))).toThrow(
      'hole "greeting" has no host',
    )
    expect(() =>
      injectHoleFallbacks(`${shell}<div data-nifra-hole="cart"></div>`, new Map([["cart", ""]])),
    ).toThrow('hole "cart" has more than one host')
    expect(() =>
      injectHoleFallbacks(
        '<div data-nifra-hole="cart"><span>x</span></div>',
        new Map([["cart", ""]]),
      ),
    ).toThrow("must render empty")
  })
})

describe("PPR runtime", () => {
  test("the runtime and every invoker are constant, so their hashes are too", async () => {
    expect(holeInvoker("cart")).toBe('__nifraPpr("cart")')
    const first = await pprScriptHashes(["cart", "recs"])
    const second = await pprScriptHashes(["cart", "recs"])
    expect(first).toEqual(second)
    expect(first).toHaveLength(3)
    for (const source of first) expect(source).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/)
    expect(new Set(first).size).toBe(3)
  })

  test("the runtime holds no nonce, token or request value and parses as a script", () => {
    expect(PPR_RUNTIME.includes("nonce")).toBe(false)
    expect(() => new Function(PPR_RUNTIME)).not.toThrow()
  })
})
