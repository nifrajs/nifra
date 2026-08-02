import { describe, expect, test } from "bun:test"
import { renderDiagnosticOverlay } from "../src/dev-error.ts"
import type { Diagnostic } from "../src/diagnostic.ts"

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

  // Preserved from the removed renderDevErrorOverlay suite: the overlay must escape attacker-controlled
  // error text + request URL so a thrown message can't inject markup into the dev overlay.
  test("escapes HTML in the message + request URL (no overlay-side XSS)", () => {
    const html = renderDiagnosticOverlay({
      code: "NIFRA_UNHANDLED",
      name: "Error",
      message: '<img src=x onerror=alert(1)> "quote"',
      request: { method: "GET", url: "/<script>" },
      frames: [],
    })
    expect(html).not.toContain("<img src=x onerror=alert(1)>")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).toContain("/&lt;script&gt;")
  })
})
