import { describe, expect, test } from "bun:test"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunEvidence } from "@nifrajs/agent-protocol"
import { RUN_PLAN_VERSION } from "@nifrajs/agent-protocol"
import {
  FileEvidenceStore,
  MemoryEvidenceStore,
  RunContractError,
} from "../src/orchestration/index.ts"

const PLAN = "d".repeat(64)

function rec(nodeId: string, status: RunEvidence["status"], seq: number): RunEvidence {
  return {
    version: RUN_PLAN_VERSION,
    runId: "r",
    planDigest: PLAN,
    nodeId,
    status,
    seq,
    idempotent: false,
  }
}

function pairFor(id: string, base: number): readonly RunEvidence[] {
  return [rec(id, "started", base), rec(id, "completed", base + 1)]
}

describe("MemoryEvidenceStore", () => {
  test("tallies counters and completed node ids", async () => {
    const store = new MemoryEvidenceStore()
    await store.append(rec("a", "started", 0))
    await store.append(rec("a", "completed", 1))
    await store.append(rec("b", "started", 2))
    await store.append(rec("b", "failed", 3))
    expect(store.count).toBe(4)
    expect(store.counters()).toEqual({ total: 4, started: 2, completed: 1, failed: 1 })
    expect(store.completedNodeIds()).toEqual(["a"])
  })

  test("keeps a bounded live window over a large stream", async () => {
    const store = new MemoryEvidenceStore({ maxLive: 100 })
    for (let i = 0; i < 10_000; i++) await store.append(rec(`n${i}`, "completed", i))
    expect(store.count).toBe(10_000)
    const live = store.live()
    expect(live.length).toBe(100)
    expect(live[0]?.nodeId).toBe("n9900")
    expect(live[99]?.nodeId).toBe("n9999")
  })

  test("terminal digest is order-independent", async () => {
    const forward = [...pairFor("a", 0), ...pairFor("b", 2), ...pairFor("c", 4)]
    const reversed = [...forward].reverse().map((r, i) => ({ ...r, seq: i }))
    const one = new MemoryEvidenceStore()
    const two = new MemoryEvidenceStore()
    for (const r of forward) await one.append(r)
    for (const r of reversed) await two.append(r)
    expect(await one.digest()).toBe(await two.digest())
  })

  test("a different outcome changes the digest", async () => {
    const one = new MemoryEvidenceStore()
    const two = new MemoryEvidenceStore()
    for (const r of pairFor("a", 0)) await one.append(r)
    await two.append(rec("a", "started", 0))
    await two.append(rec("a", "failed", 1))
    expect(await one.digest()).not.toBe(await two.digest())
  })

  test("a forbidden content field is rejected", async () => {
    const store = new MemoryEvidenceStore()
    const poisoned = { ...rec("a", "completed", 0), prompt: "leak me" } as unknown as RunEvidence
    await expect(store.append(poisoned)).rejects.toThrow(RunContractError)
    expect(store.count).toBe(0)
  })
})

describe("FileEvidenceStore", () => {
  const path = join(tmpdir(), "nifra-evidence-store.jsonl")

  test("persists one canonical line per record in append order", async () => {
    await rm(path, { force: true })
    const store = new FileEvidenceStore({ path })
    await store.append(rec("a", "started", 0))
    await store.append(rec("a", "completed", 1))
    const lines = (await readFile(path, "utf8")).trim().split("\n")
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0] as string).status).toBe("started")
    expect(JSON.parse(lines[1] as string).status).toBe("completed")
    // Canonical form has sorted keys: version comes after status/seq alphabetically-> confirm no payload.
    expect(lines[0]).not.toContain("prompt")
  })

  test("a forbidden content field is never written to the file", async () => {
    const guarded = join(tmpdir(), "nifra-evidence-store-guarded.jsonl")
    await rm(guarded, { force: true })
    const store = new FileEvidenceStore({ path: guarded })
    const poisoned = { ...rec("a", "completed", 0), thinking: "secret" } as unknown as RunEvidence
    await expect(store.append(poisoned)).rejects.toThrow(RunContractError)
    await expect(readFile(guarded, "utf8")).rejects.toThrow() // file never created
    expect(store.count).toBe(0)
  })
})
