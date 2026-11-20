import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { format } from "node:util"
import { classify, isConsoleDiagnostic } from "@nifrajs/web/diagnostic"
import { h } from "preact"
import "preact/debug"
import { renderToString } from "preact-render-to-string"
import ts from "typescript"

test("Preact's debug build reports an invalid component as a nifra error", () => {
  let thrown = ""
  try {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: an undefined component type is the case under test; the type forbids it on purpose.
    renderToString(h(undefined as never, null))
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }
  expect(classify("Error", thrown)).toMatchObject({ code: "NIFRA_PREACT_DIAGNOSTIC" })
  expect(classify("Error", thrown).severity).toBeUndefined()
})

test("Preact's duplicate-key warning is a nifra warning", () => {
  const seen: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    seen.push(format(...args))
  }
  try {
    renderToString(h("ul", null, [h("li", { key: "a" }, "1"), h("li", { key: "a" }, "2")]))
  } finally {
    console.error = original
  }
  const message = seen.find((line) => line.startsWith("Following component"))
  expect(message).toBeDefined()
  expect(isConsoleDiagnostic(message ?? "")).toBe(true)
  expect(classify("Warning", message ?? "")).toMatchObject({
    code: "NIFRA_PREACT_DIAGNOSTIC",
    severity: "warning",
  })
})

// Preact has no code to match on, so the catalog lists message openings. Every literal message the
// installed debug build logs or throws must open with one, or a Preact release has outgrown the list.
test("every message in the installed preact/debug is recognised", () => {
  const debugDir = join(
    dirname(Bun.resolveSync("preact/package.json", import.meta.dir)),
    "debug/src",
  )
  const unrecognised: string[] = []
  let sites = 0
  // A hydration mismatch keeps its own code whichever framework reports it.
  const recognised = (name: string, text: string): boolean =>
    ["NIFRA_PREACT_DIAGNOSTIC", "NIFRA_HYDRATION_MISMATCH"].includes(classify(name, text).code)
  for (const file of readdirSync(debugDir).filter((name) => name.endsWith(".js"))) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(join(debugDir, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    )
    const opening = (node: ts.Expression): string | undefined => {
      if (ts.isStringLiteralLike(node)) return node.text
      // An interpolated value stands in as "x": the opening of the message is what the catalog reads.
      if (ts.isTemplateExpression(node))
        return node.head.text + node.templateSpans.map((span) => `x${span.literal.text}`).join("")
      if (ts.isBinaryExpression(node)) return opening(node.left)
      return undefined
    }
    const visit = (node: ts.Node): void => {
      const call = ts.isCallExpression(node) ? node : undefined
      const callee = call?.expression.getText(sf)
      if (call !== undefined && (callee === "console.warn" || callee === "console.error")) {
        const text = call.arguments[0] === undefined ? undefined : opening(call.arguments[0])
        if (text !== undefined && text !== "") {
          sites++
          if (!recognised("Warning", text)) unrecognised.push(text)
        }
      }
      if (ts.isThrowStatement(node) && ts.isNewExpression(node.expression)) {
        const first = node.expression.arguments?.[0]
        const text = first === undefined ? undefined : opening(first)
        if (text !== undefined && text !== "") {
          sites++
          if (!recognised("Error", text)) unrecognised.push(text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  expect(sites).toBeGreaterThan(10)
  expect(unrecognised).toEqual([])
})
