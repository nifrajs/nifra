import { describe, expect, test } from "bun:test"
import { renderDevErrorOverlay, renderDiagnosticOverlay } from "../src/dev-error.ts"
import type { Diagnostic } from "../src/diagnostic.ts"

describe("renderDevErrorOverlay", () => {
  const req = { method: "GET", url: "/products/42" }

  test("renders message, source-mapped frames, and the request line", () => {
    const err = new Error("loader blew up")
    err.stack =
      "Error: loader blew up\n    at loader (/src/products.tsx:10:5)\n    at run (/src/app.ts:3:1)"
    const html = renderDevErrorOverlay(err, req)
    expect(html).toContain("loader blew up")
    expect(html).toContain("at loader (/src/products.tsx:10:5)")
    expect(html).toContain("GET /products/42")
    expect(html).toContain("nifra dev") // labeled as the dev overlay
    expect(html.startsWith("<!doctype html>")).toBe(true)
  })

  test("escapes HTML in the message + request (no overlay-side XSS from error text/url)", () => {
    const err = new Error('<img src=x onerror=alert(1)> "quote"')
    const html = renderDevErrorOverlay(err, { method: "GET", url: "/<script>" })
    expect(html).not.toContain("<img src=x onerror=alert(1)>")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).toContain("/&lt;script&gt;")
  })

  test("handles a non-Error throw", () => {
    const html = renderDevErrorOverlay("just a string", req)
    expect(html).toContain("just a string")
    expect(html).toContain("<!doctype html>")
  })

  test("handles an error with no stack frames", () => {
    const err = new Error("no frames")
    err.stack = "Error: no frames"
    const html = renderDevErrorOverlay(err, req)
    expect(html).toContain("no frames")
    expect(html).toContain("No stack frames")
  })
})

describe("renderDiagnosticOverlay", () => {
  test("renders the code badge, the codeframe with its caret, and the cause/fix callout", () => {
    const diagnostic: Diagnostic = {
      code: "NIFRA_SERVER_ONLY_IN_CLIENT",
      name: "Error",
      message: "server-only module reached the client",
      request: { method: "GET", url: "/dashboard" },
      frames: [
        { raw: "at handler (/src/index.tsx:3:9)", file: "/src/index.tsx", line: 3, column: 9 },
      ],
      codeframe: {
        file: "/src/index.tsx",
        line: 3,
        column: 9,
        lines: [
          { number: 2, text: "const secret = load()", caret: false },
          { number: 3, text: "throw new Error('boom')", caret: true },
          { number: 4, text: "", caret: false },
        ],
      },
      cause: "A server-only module was reachable from a client entry.",
      fix: "Move the server-only use behind a loader or a *.server.ts boundary.",
      docsAnchor: "errors#server-only-in-client",
    }
    const html = renderDiagnosticOverlay(diagnostic)
    expect(html).toContain("NIFRA_SERVER_ONLY_IN_CLIENT") // code badge
    expect(html).toContain("/src/index.tsx:3:9") // codeframe location
    expect(html).toContain("throw new Error('boom')") // the offending source line, rendered
    expect(html).toContain("cf-row caret") // the offending line carries the caret class
    expect(html).toContain("likely fix") // the callout tag
    expect(html).toContain("A server-only module was reachable from a client entry.") // cause
    expect(html).toContain("Move the server-only use behind a loader") // fix
    expect(html).toContain("errors#server-only-in-client") // docs anchor
  })

  test("omits the codeframe and fix callout when the diagnostic has neither", () => {
    const diagnostic: Diagnostic = {
      code: "NIFRA_UNHANDLED",
      name: "TypeError",
      message: "x is not a function",
      frames: [],
    }
    const html = renderDiagnosticOverlay(diagnostic)
    expect(html).toContain("NIFRA_UNHANDLED")
    expect(html).not.toContain("likely fix")
    expect(html).not.toContain('class="codeframe"')
    expect(html).toContain("No stack frames")
  })
})
