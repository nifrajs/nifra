import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as middleware from "@nifrajs/middleware"

const SKILL = join(import.meta.dir, "../../skills/skills/nifra-api/SKILL.md")

test("every middleware the API skill names is an export", () => {
  const text = readFileSync(SKILL, "utf8")
  const section = /^## Middleware\n([\s\S]*?)\n\n/m.exec(text)?.[1] ?? ""
  const names = [...section.matchAll(/`([A-Za-z]\w*)`/g)].map((match) => match[1] ?? "")
  expect(names.length).toBeGreaterThan(20)
  expect(names.filter((name) => !(name in middleware))).toEqual([])
})
