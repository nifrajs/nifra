import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CompactionReport, ContextWindow, FileSessionStore } from "../src/sessions.ts"

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

describe("sessions and compaction", () => {
  test("appends redacted JSONL evidence and forks a session", async () => {
    const root = await mkdtemp(join(tmpdir(), "nifra-agent-session-"))
    roots.push(root)
    const store = new FileSessionStore({ root })
    await store.append("main", "tool.completed", { apiKey: "secret", ok: true })
    await store.append("main", "verification.completed", { ok: true }, { pinned: true })
    const entries = await store.read("main")
    expect(entries).toHaveLength(2)
    expect(entries[0]?.payload).toEqual({ apiKey: "[redacted]", ok: true })
    const fork = await store.fork("main", "review")
    expect(fork).toBe("review")
    expect((await store.read("review")).map((entry) => entry.sessionId)).toEqual([
      "review",
      "review",
    ])
  })

  test("automatically compacts while retaining pinned evidence", () => {
    const context = new ContextWindow({ maxTokens: 256, keepRecent: 2, maxSummaryChars: 512 })
    context.append({ kind: "verification.completed", content: "must remain", pinned: true })
    let report: CompactionReport | undefined
    for (let index = 0; index < 12; index++)
      report = context.append({ kind: "assistant.message", content: "x".repeat(400) })
    expect(report?.removed).toBeGreaterThan(0)
    expect(context.snapshot().some((item) => item.kind === "verification.completed")).toBe(true)
    expect(context.snapshot().some((item) => item.kind === "memory.summary")).toBe(true)
    expect(context.size).toBeLessThan(8)
    expect(context.tokens).toBeLessThan(256 * 2)
  })

  test("accepts an extension-owned bounded compaction summary", () => {
    const context = new ContextWindow({
      maxTokens: 256,
      keepRecent: 1,
      maxSummaryChars: 80,
      summarize: (records) => `custom:${records.length}`,
    })
    for (let index = 0; index < 8; index++)
      context.append({ kind: "tool.delta", content: "x".repeat(300) })
    context.compact("manual")
    expect(context.snapshot().find((item) => item.kind === "memory.summary")?.content).toMatch(
      /^custom:/,
    )
  })

  test("retains a bounded tail and serializes concurrent appends", async () => {
    const root = await mkdtemp(join(tmpdir(), "nifra-agent-session-bounded-"))
    roots.push(root)
    const store = new FileSessionStore({
      root,
      maxEntries: 3,
      maxBytes: 4_096,
      maxEntryBytes: 1_024,
    })
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        store.append("bounded", "event", { index, text: "x".repeat(100) }),
      ),
    )
    const entries = await store.read("bounded")
    expect(entries).toHaveLength(3)
    expect(entries.map((entry) => entry.seq)).toEqual([5, 6, 7])
    expect(await store.read("bounded", 1)).toEqual([entries[2]!])
    expect((await stat(join(root, "bounded.jsonl"))).size).toBeLessThanOrEqual(4_096)
    expect(
      (await readFile(join(root, "bounded.jsonl"), "utf8")).split("\n").filter(Boolean),
    ).toHaveLength(3)
  })

  test("does not overwrite an existing fork destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "nifra-agent-session-fork-"))
    roots.push(root)
    const store = new FileSessionStore({ root })
    await store.append("main", "event", { ok: true })
    await store.append("review", "event", { keep: true })
    await expect(store.fork("main", "review")).rejects.toThrow()
    expect((await store.read("review"))[0]?.payload).toEqual({ keep: true })
  })
})
