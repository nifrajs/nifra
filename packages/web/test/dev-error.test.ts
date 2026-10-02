import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { renderDiagnosticOverlay } from "../src/dev-error.ts"
import { buildDiagnostic, type Diagnostic, fixPrompts } from "../src/diagnostic.ts"

describe("renderDiagnosticOverlay", () => {
  test("renders the code badge, the codeframe with its caret, and the cause/fix callout", () => {
    const diagnostic: Diagnostic = {
      code: "NIFRA_BACKEND_ONLY_IN_CLIENT",
      name: "Error",
      message: "backend-only module reached the client",
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
      cause: "A backend-only module was reachable from a client entry.",
      fix: "Move the backend-only use behind the route's x.backend.ts loader.",
      docsAnchor: "errors#backend-only-in-client",
    }
    const html = renderDiagnosticOverlay(diagnostic)
    expect(html).toContain("NIFRA_BACKEND_ONLY_IN_CLIENT") // code badge
    expect(html).toContain("/src/index.tsx:3:9") // codeframe location
    expect(html).toContain("throw new Error('boom')") // the offending source line, rendered
    expect(html).toContain("cf-row caret") // the offending line carries the caret class
    expect(html).toContain("likely fix") // the callout tag
    expect(html).toContain("A backend-only module was reachable from a client entry.") // cause
    expect(html).toContain("Move the backend-only use behind") // fix
    expect(html).toContain("errors#backend-only-in-client") // docs anchor
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

  test("one copy button per labeled fix, each prompt readable without JS", () => {
    const err = new Error("routes/a.tsx imports backend/db.ts, which may not ship to a browser")
    err.stack = `${err.name}: ${err.message}\n    at Page (/app/routes/a.tsx:2:3)`
    const diagnostic = buildDiagnostic(err, { root: "/app", read: () => undefined })
    const html = renderDiagnosticOverlay(
      diagnostic,
      fixPrompts(diagnostic, { surface: "overlay", root: "/app" }),
    )
    expect(html.match(/<button type="button" data-prompt="\d">/g)).toHaveLength(3)
    expect(html).toContain("Copy prompt: Make it a server function")
    expect(html.match(/<textarea id="nifra-prompt-\d" readonly/g)).toHaveLength(3)
    expect(html).toContain('aria-live="polite"')
  })

  test("the overlay's CSP admits exactly its own copy script", () => {
    const html = renderDiagnosticOverlay(
      { code: "NIFRA_UNHANDLED", name: "Error", message: "boom", frames: [] },
      [{ label: "Diagnose", prompt: "p" }],
    )
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ""
    const hash = createHash("sha256").update(script).digest("base64")
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? ""
    expect(csp).toContain(`script-src 'sha256-${hash}';`)
    expect(csp).toContain("default-src 'none'")
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script>"))
  })

  test("a prompt cannot close its textarea or start a script", () => {
    const html = renderDiagnosticOverlay(
      { code: "NIFRA_UNHANDLED", name: "Error", message: "boom", frames: [] },
      [{ label: "<b>x</b>", prompt: "</textarea><script>alert(1)</script>" }],
    )
    expect(html).not.toContain("</textarea><script>alert(1)")
    expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain("<b>x</b>")
  })

  test("no prompts, no copy script", () => {
    const html = renderDiagnosticOverlay({
      code: "NIFRA_UNHANDLED",
      name: "E",
      message: "m",
      frames: [],
    })
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("Prompt for your coding agent")
  })
})
