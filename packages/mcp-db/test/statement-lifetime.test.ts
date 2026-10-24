import { Database } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openReadOnlySqlite } from "../src/engine.ts"

test("read-only connections untrack finalized statements and close live ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-statement-lifetime-"))
  const file = join(dir, "app.db")
  const seed = new Database(file)
  seed.run("CREATE TABLE t (id INTEGER)")
  seed.close(true)
  const db = await openReadOnlySqlite(file)
  try {
    // Keep these statements reachable deliberately: close must no longer visit them, independent
    // of whether this runtime's collector happens to reclaim a weak target during the test.
    const finalized = Array.from({ length: 100 }, () => {
      const statement = db.prepare("SELECT 1 AS n")
      const finalize = spyOn(statement, "finalize")
      statement.all()
      statement.finalize()
      return finalize
    })
    const live = db.prepare("SELECT 1 AS n")
    const finalizeLive = spyOn(live, "finalize")
    expect(live.get()).toEqual({ n: 1n })
    db.close(true)
    for (const finalize of finalized) expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalizeLive).toHaveBeenCalledTimes(1)
    expect(() => live.get()).toThrow()
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
