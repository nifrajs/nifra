import { expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { format } from "node:util"
import { classify, isConsoleDiagnostic } from "@nifrajs/web/diagnostic"

// Every warning Svelte's client runtime can print, called through its own functions: a release that
// changes the format, or adds a warning the catalog would miss, fails here.
test("every Svelte runtime warning is a nifra warning", async () => {
  const root = dirname(Bun.resolveSync("svelte/package.json", import.meta.dir))
  const warnings: Record<string, (...args: string[]) => void> = await import(
    join(root, "src/internal/client/warnings.js")
  )
  const names = Object.keys(warnings)
  expect(names.length).toBeGreaterThan(10)
  const original = console.warn
  const seen: string[] = []
  console.warn = (...args: unknown[]) => {
    seen.push(format(...args))
  }
  try {
    for (const name of names) warnings[name]?.("a", "b", "c", "d")
  } finally {
    console.warn = original
  }
  expect(seen.length).toBeGreaterThanOrEqual(names.length)
  for (const message of seen) {
    expect(isConsoleDiagnostic(message)).toBe(true)
    const { code } = classify("Warning", message)
    // A hydration warning keeps the hydration code whichever framework reports it.
    expect(["NIFRA_SVELTE_DIAGNOSTIC", "NIFRA_HYDRATION_MISMATCH"]).toContain(code)
    if (code === "NIFRA_SVELTE_DIAGNOSTIC")
      expect(classify("Warning", message).severity).toBe("warning")
  }
})
