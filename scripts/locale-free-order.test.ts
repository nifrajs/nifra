import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const LOCALE_ORDER = /\.localeCompare\(|\bIntl\.Collator\b/

test("shipped code and repo scripts never order strings by the runtime's locale", () => {
  const offenders: string[] = []
  const sources = [
    ...new Bun.Glob("packages/*/src/**/*.{ts,tsx,mts}").scanSync({ cwd: ROOT }),
    ...new Bun.Glob("scripts/**/*.ts").scanSync({ cwd: ROOT }),
  ]
  expect(sources.length).toBeGreaterThan(100)
  for (const file of sources) {
    if (file.endsWith(".d.ts") || file.endsWith(".test.ts") || file.includes("/fixtures/")) continue
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n")
    lines.forEach((line, index) => {
      if (LOCALE_ORDER.test(line)) offenders.push(`${file}:${index + 1}`)
    })
  }
  expect(offenders).toEqual([])
})
