import { expect, test } from "bun:test"
import { format } from "node:util"
import { classify, isConsoleDiagnostic } from "@nifrajs/web/diagnostic"
import { createElement } from "react"
import { renderToString } from "react-dom/server"

// React 19 prints a DOM-prop warning with no `Warning: ` prefix and no react.dev link.
test("React's unrecognised-prop warning is a nifra warning, not a plain log", () => {
  const seen: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    seen.push(format(...args))
  }
  try {
    renderToString(createElement("div", { fooBar: 1 }))
  } finally {
    console.error = original
  }
  const message = seen.find((text) => text.includes("fooBar")) ?? ""
  expect(message).not.toBe("")
  expect(isConsoleDiagnostic(message)).toBe(true)
  expect(classify("Warning", message)).toMatchObject({
    code: "NIFRA_REACT_WARNING",
    severity: "warning",
  })
  // An unrelated console.error is not a React report.
  expect(isConsoleDiagnostic("connection refused")).toBe(false)
})

// The warning React's own development build prints, not a copy of its text.
test("React's missing-key warning is a nifra warning, not an error", () => {
  const seen: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    seen.push(format(...args))
  }
  try {
    renderToString(
      createElement("ul", null, [createElement("li", null, "a"), createElement("li", null, "b")]),
    )
  } finally {
    console.error = original
  }
  expect(seen).toHaveLength(1)
  const message = seen[0] ?? ""
  expect(isConsoleDiagnostic(message)).toBe(true)
  expect(classify("Warning", message)).toMatchObject({
    code: "NIFRA_REACT_WARNING",
    severity: "warning",
  })
})
