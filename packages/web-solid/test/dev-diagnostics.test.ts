import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { classify, isConsoleDiagnostic, SOLID_ERROR_CODES } from "@nifrajs/web/diagnostic"

const solidRoot = dirname(Bun.resolveSync("solid-js/package.json", import.meta.dir))

interface SolidDiagnostic {
  readonly code: string
  readonly severity: readonly string[]
  readonly guideUrl: string
}

const diagnostics: SolidDiagnostic[] = JSON.parse(
  readFileSync(join(solidRoot, "diagnostics.json"), "utf8"),
)

// The report as Solid's development build prints it: the message, the owner path and source location,
// then the footer it appends to every report.
const report = (entry: SolidDiagnostic): string =>
  [
    `[${entry.code}] something Solid observed`,
    "in <App> › <Item> › effect",
    "at src/Item.tsx:12:19",
    `[${entry.code}] what it means and how to fix it: ${entry.guideUrl}`,
    `[${entry.code}] agent repair guide: node_modules/solid-js/skills/reactivity-diagnostics/SKILL.md#${entry.code.toLowerCase()}`,
  ].join("\n")

test("the footer Solid appends is the one the catalog recognises", () => {
  const source = readFileSync(join(solidRoot, "dist/solid.dev.js"), "utf8")
  expect(source).toContain("] agent repair guide: node_modules/${SKILL_PATH}${anchor}")
  expect(source).toContain('const SKILL_PATH = "solid-js/skills/reactivity-diagnostics/SKILL.md"')
})

test("every Solid diagnostic classifies, at the severity Solid gives it", () => {
  expect(diagnostics.length).toBeGreaterThan(50)
  for (const entry of diagnostics) {
    const message = report(entry)
    expect(isConsoleDiagnostic(message)).toBe(true)
    const result = classify("Warning", message)
    expect(result.code).toBe("NIFRA_SOLID_DIAGNOSTIC")
    expect(result.severity).toBe(entry.severity.includes("error") ? undefined : "warning")
  }
})

test("the catalog's list of Solid error codes is the installed release's", () => {
  const installed = diagnostics
    .filter((entry) => entry.severity.includes("error"))
    .map((entry) => entry.code)
    .sort()
  expect([...SOLID_ERROR_CODES].sort()).toEqual(installed)
})
