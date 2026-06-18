import { describe, expect, test } from "bun:test"
import { renderDevErrorOverlay } from "../src/dev-error.ts"

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
