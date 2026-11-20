import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RULE_CODES } from "../packages/cli/src/rules/codes.ts"
import { DIAGNOSTIC_CATALOG } from "../packages/web/src/diagnostic-catalog.ts"
import { renderErrorSkill } from "./gen-error-skill.ts"

const committed = readFileSync(
  join(import.meta.dir, "../packages/skills/skills/nifra-errors/SKILL.md"),
  "utf8",
)

test("the committed repair guide is what the catalogs generate", () => {
  expect(committed).toBe(renderErrorSkill())
})

test("every runtime code and every rule code has a heading an agent can jump to", () => {
  for (const entry of DIAGNOSTIC_CATALOG) expect(committed).toContain(`### ${entry.code}\n`)
  for (const code of Object.keys(RULE_CODES)) expect(committed).toContain(`### ${code}\n`)
})

test("the guide is loadable: frontmatter name matches its directory", () => {
  expect(committed.startsWith("---\nname: nifra-errors\ndescription: ")).toBe(true)
})
