import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type CompactionReport,
  ContextWindow,
  FileSessionStore,
  sessionFileStem,
} from "../src/sessions.ts"

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

  test("keeps token counts while redacting token values", async () => {
    const root = await mkdtemp(join(tmpdir(), "nifra-agent-session-"))
    roots.push(root)
    const store = new FileSessionStore({ root })
    await store.append("main", "context.usage", {
      usedTokens: 10,
      max_output_tokens: 4096,
      authToken: "abc",
      sessionTokens: ["abc"],
      token: 123456,
      secretTokens: 123456,
      apiKeyTokens: 42,
    })
    expect((await store.read("main"))[0]?.payload).toEqual({
      usedTokens: 10,
      max_output_tokens: 4096,
      authToken: "[redacted]",
      sessionTokens: "[redacted]",
      token: "[redacted]",
      secretTokens: "[redacted]",
      apiKeyTokens: "[redacted]",
    })
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

  test("pinned records cannot grow the window past its bound", () => {
    const context = new ContextWindow({ maxTokens: 256, keepRecent: 4 })
    for (let index = 0; index < 2_000; index++)
      context.append({ kind: "approval.required", content: `approval ${index}`, pinned: true })
    expect(context.tokens).toBeLessThanOrEqual(256)
    const kept = context.snapshot().filter((item) => item.kind === "approval.required")
    expect(kept.at(-1)?.content).toBe("approval 1999")
    expect(context.snapshot().some((item) => item.kind === "memory.summary")).toBe(true)
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
    // Compaction keeps the newest entries down to three quarters of the cap: 3 -> 2 here.
    const entries = await store.read("bounded")
    expect(entries.map((entry) => entry.seq)).toEqual([6, 7])
    expect(await store.read("bounded", 1)).toEqual([entries[1]!])
    expect((await stat(join(root, "bounded.jsonl"))).size).toBeLessThanOrEqual(4_096)
    expect(
      (await readFile(join(root, "bounded.jsonl"), "utf8")).split("\n").filter(Boolean),
    ).toHaveLength(2)
  })

  test("an append reads the log back only to compact it", async () => {
    const root = await mkdtemp(join(tmpdir(), "nifra-agent-session-cost-"))
    roots.push(root)
    const countTailReads = (store: FileSessionStore): (() => number) => {
      let reads = 0
      const original: unknown = Reflect.get(store, "readTailText")
      if (typeof original !== "function") throw new Error("expected a tail reader")
      Reflect.set(store, "readTailText", (...args: unknown[]) => {
        reads++
        return Reflect.apply(original, store, args)
      })
      return () => reads
    }
    const roomy = new FileSessionStore({ root })
    const roomyReads = countTailReads(roomy)
    for (let index = 0; index < 200; index++) await roomy.append("roomy", "event", { index })
    expect(roomyReads()).toBe(1)

    const tight = new FileSessionStore({ root, maxEntries: 8 })
    const tightReads = countTailReads(tight)
    for (let index = 0; index < 200; index++) await tight.append("tight", "event", { index })
    expect(tightReads()).toBeLessThanOrEqual(1 + Math.ceil(200 / 3))
    const retained = await tight.read("tight")
    expect(retained.at(-1)?.seq).toBe(199)
    expect(retained.length).toBeLessThanOrEqual(8)
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

describe("session file names", () => {
  test("a session id's colons and device names are escaped in Windows file names only", () => {
    expect(sessionFileStem("run:fork:abc", "win32")).toBe("run%3Afork%3Aabc")
    expect(sessionFileStem("run:fork:abc", "darwin")).toBe("run:fork:abc")
    expect(sessionFileStem("plain-id", "win32")).toBe("plain-id")
    expect(sessionFileStem("nul", "win32")).toBe("%6Eul")
    expect(sessionFileStem("Com1.fork", "win32")).toBe("%43om1.fork")
    expect(sessionFileStem("aux:1", "win32")).toBe("aux%3A1")
    expect(sessionFileStem("AUX", "win32")).toBe("%41UX")
    expect(sessionFileStem("console", "win32")).toBe("console")
    expect(sessionFileStem("nul", "darwin")).toBe("nul")
  })
})
