import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
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
})
