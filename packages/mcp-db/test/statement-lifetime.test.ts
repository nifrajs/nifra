import { Database, Statement } from "bun:sqlite"
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

test("collected statements are removed from close-time tracking", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-statement-collected-"))
  const file = join(dir, "app.db")
  const seed = new Database(file)
  seed.run("CREATE TABLE t (id INTEGER)")
  seed.close(true)
  const callbacks: (() => void)[] = []
  const OriginalRegistry = globalThis.FinalizationRegistry
  class ControlledRegistry<T> extends OriginalRegistry<T> {
    constructor(readonly cleanup: (held: T) => void) {
      super(cleanup)
    }
    override register(target: WeakKey, held: T, token?: WeakKey): void {
      super.register(target, held, token)
      callbacks.push(() => this.cleanup(held))
    }
  }
  let db: Database | undefined
  try {
    globalThis.FinalizationRegistry = ControlledRegistry
    db = await openReadOnlySqlite(file)
    globalThis.FinalizationRegistry = OriginalRegistry
    const statement = db.prepare("SELECT 1 AS n")
    const finalize = spyOn(statement, "finalize")
    const collect = callbacks.at(-1)
    if (collect === undefined) throw new Error("statement must register weak cleanup")
    // Model native resource disposal followed by the collector callback, without waiting for GC.
    // Bypass the wrapper's explicit-finalize cleanup so only the registry can untrack this entry.
    Statement.prototype.finalize.call(statement)
    collect()
    db.close(true)
    expect(finalize).not.toHaveBeenCalled()
  } finally {
    globalThis.FinalizationRegistry = OriginalRegistry
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
