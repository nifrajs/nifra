import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openReadOnlySqlite } from "../src/engine.ts"

function finalizedSample(db: Database): WeakRef<object>[] {
  return Array.from({ length: 100 }, () => {
    const statement = db.prepare("SELECT 1 AS n")
    statement.all()
    statement.finalize()
    return new WeakRef(statement)
  })
}

test("read-only connections release finalized statements and close live ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-statement-lifetime-"))
  const file = join(dir, "app.db")
  const seed = new Database(file)
  seed.run("CREATE TABLE t (id INTEGER)")
  seed.close(true)
  const db = await openReadOnlySqlite(file)
  try {
    const refs = finalizedSample(db)
    // WeakRef targets stay alive until the end of their creation job.
    await Bun.sleep(0)
    for (let i = 0; i < 3; i++) {
      Bun.gc(true)
      await Bun.sleep(0)
    }
    expect(refs.filter((ref) => ref.deref() !== undefined)).toHaveLength(0)
    const live = db.prepare("SELECT 1 AS n")
    expect(live.get()).toEqual({ n: 1n })
    db.close(true)
    expect(() => live.get()).toThrow()
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
