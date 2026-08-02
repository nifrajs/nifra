import { describe, expect, test } from "bun:test"
import { createDevDiagnostics } from "../src/dev-diagnostics.ts"
import { LAST_ERROR_PATH } from "../src/diagnostic.ts"

// The shared surface both dev-server adapters (Bun + Vite) drive. Testing it directly is the point of the
// extraction: the last-error contract is exercised once here instead of twice through two live servers.
describe("createDevDiagnostics", () => {
  test("isLastErrorPath matches only the last-error endpoint", () => {
    const d = createDevDiagnostics("/app")
    expect(d.isLastErrorPath(LAST_ERROR_PATH)).toBe(true)
    expect(d.isLastErrorPath("/")).toBe(false)
    expect(d.isLastErrorPath("/__nifra/other")).toBe(false)
  })

  test("before any failure, lastError is a benign NIFRA_NONE with the identity + no-store headers", () => {
    const { body, headers } = createDevDiagnostics("/app").lastError()
    expect(JSON.parse(body)).toMatchObject({ code: "NIFRA_NONE" })
    expect(headers["x-nifra-diagnostic"]).toBe("true") // the check nifra_explain/nifra_inspect gate on
    expect(headers["cache-control"]).toBe("no-store")
    expect(headers["x-content-type-options"]).toBe("nosniff")
    expect(headers["content-type"]).toContain("application/json")
  })

  test("capture stores the failure so lastError then serves it, and returns overlay HTML", () => {
    const d = createDevDiagnostics("/app")
    const html = d.capture(new Error("loader blew up"), { method: "GET", url: "/x" })
    expect(html).toContain("<!doctype html>")
    expect(html).toContain("loader blew up")
    // The same captured Diagnostic now backs the JSON endpoint - overlay and agent see one failure.
    const served = JSON.parse(d.lastError().body)
    expect(served.code).not.toBe("NIFRA_NONE")
    expect(served.message).toContain("loader blew up")
  })
})
