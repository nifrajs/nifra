import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DIAGNOSTIC_CATALOG } from "../src/diagnostic.ts"

// The overlay, nifra_explain and nifra_errors hand out `docsAnchor`; each must land on a section.
test("every catalog code has its section on the error codes page", () => {
  const page = readFileSync(join(import.meta.dir, "../../../site/routes/docs/errors.tsx"), "utf8")
  for (const entry of DIAGNOSTIC_CATALOG) {
    const [path, id] = entry.docsAnchor.split("#")
    expect(path).toBe("errors")
    expect(page).toContain(`<h3 id="${id}">${entry.code}</h3>`)
  }
})
