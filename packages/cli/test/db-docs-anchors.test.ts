import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type DbRefusalCode, dbRefusal } from "@nifrajs/mcp-db/engine"

// A Record over the union: a code added to DbRefusalCode fails to compile here until it is listed.
const CODES: Record<DbRefusalCode, true> = {
  NIFRA_DB_NOT_DECLARED: true,
  NIFRA_DB_CONFIG: true,
  NIFRA_DB_OUTSIDE_ROOT: true,
  NIFRA_DB_REMOTE_HOST: true,
  NIFRA_DB_SUPERUSER: true,
  NIFRA_DB_EXTENSION: true,
  NIFRA_DB_QUERY_OFF: true,
  NIFRA_DB_WRITE_REFUSED: true,
  NIFRA_DB_FUNCTION_REFUSED: true,
  NIFRA_DB_TABLE_EXCLUDED: true,
  NIFRA_DB_COLUMN_REFUSED: true,
  NIFRA_DB_TIMEOUT: true,
  NIFRA_DB_QUERY_FAILED: true,
  NIFRA_DB_DRIVER: true,
}

test("every NIFRA_DB_* refusal links to its own section of the agents docs page", () => {
  const page = readFileSync(join(import.meta.dir, "../../../site/routes/docs/agents.tsx"), "utf8")
  const codes = Object.keys(CODES).filter((key): key is DbRefusalCode => Object.hasOwn(CODES, key))
  for (const code of codes) {
    const { docsAnchor } = dbRefusal(code, "")
    const [path, anchor] = docsAnchor.split("#")
    expect(path).toBe("agents")
    expect({ code, section: page.includes(`<h3 id="${anchor}">${code}</h3>`) }).toEqual({
      code,
      section: true,
    })
  }
})
