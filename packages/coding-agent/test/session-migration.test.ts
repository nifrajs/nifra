import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { appendFile, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  migrateLegacySession,
  parseSessionEvidenceRecord,
  SessionMigrationError,
} from "../src/session-migration.ts"
import { FileSessionStore } from "../src/sessions.ts"

const roots: string[] = []
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  // Runs even after a timeout, so a FIFO writer left open cannot keep the run alive.
  while (closers.length > 0) await closers.pop()!()
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

async function fixture(): Promise<{ source: string; target: string }> {
  const root = await mkdtemp(join(tmpdir(), "nifra-session-migration-"))
  roots.push(root)
  const source = join(root, "legacy")
  const target = join(root, "evidence")
  await mkdir(source, { recursive: true })
  await Bun.write(
    join(source, "session-1.jsonl"),
    `${JSON.stringify({ version: 1, sessionId: "session-1", seq: 0, at: 100, type: "session.started", payload: { cwd: "/private", prompt: "secret" } })}\n` +
      `${JSON.stringify({ version: 1, sessionId: "session-1", seq: 1, at: 101, type: "future.event", payload: { output: "secret" }, pinned: true })}\n`,
  )
  return { source, target }
}

describe("legacy FileSessionStore evidence migration", () => {
  // A FIFO whose writer never closes has no end: only a read that stops at the cap can return.
  test.skipIf(process.platform === "win32")(
    "an oversized source is refused without reading it to the end",
    async () => {
      const { source, target } = await fixture()
      const fifo = join(source, "endless.jsonl")
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0)
      const migrating = migrateLegacySession({
        sourceRoot: source,
        targetRoot: target,
        sessionId: "endless",
        maxSourceBytes: 1_024,
      })
      const writer = await open(fifo, "w")
      closers.push(() => writer.close())
      await writer.write(Buffer.alloc(4_096, 0x20))
      await expect(migrating).rejects.toMatchObject({ code: "source_too_large" })
    },
  )

  test("preserves identity, ordering, timestamps, counts, and digest without payload content", async () => {
    const { source, target } = await fixture()
    const report = await migrateLegacySession({
      sourceRoot: source,
      targetRoot: target,
      sessionId: "session-1",
    })
    expect(report.records).toBe(2)
    expect(report.firstSeq).toBe(0)
    expect(report.lastSeq).toBe(1)
    expect(report.skipped).toBe(1)
    const text = await readFile(join(target, "session-1.jsonl"), "utf8")
    expect(text).not.toContain("private")
    expect(text).not.toContain("secret")
    const records = text
      .trim()
      .split("\n")
      .map((line) => parseSessionEvidenceRecord(JSON.parse(line)))
    expect(records.map((record) => [record.sessionId, record.seq, record.at])).toEqual([
      ["session-1", 0, 100],
      ["session-1", 1, 101],
    ])
    expect(records[1]?.code).toMatch(/^legacy\.unknown\.[0-9a-f]{16}$/)
    expect(report.counts["session.started"]).toBe(1)
    expect(report.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  test("FileSessionStore reads a migrated target and continues its sequence", async () => {
    const { source, target } = await fixture()
    await migrateLegacySession({ sourceRoot: source, targetRoot: target, sessionId: "session-1" })
    const store = new FileSessionStore({ root: target })
    const entries = await store.read("session-1")
    expect(entries.map((entry) => [entry.seq, entry.at, entry.type, entry.pinned])).toEqual([
      [0, 100, "session.started", undefined],
      [1, 101, expect.stringMatching(/^legacy\.unknown\./), true],
    ])
    expect(entries.some((entry) => "payload" in entry)).toBe(false)
    expect((await store.append("session-1", "turn.started", { turnId: "t2" })).seq).toBe(2)
    expect((await store.read("session-1")).map((entry) => entry.seq)).toEqual([0, 1, 2])
  })

  test("rejects an existing target and leaves the legacy source byte-identical", async () => {
    const { source, target } = await fixture()
    await Bun.write(join(target, "session-1.jsonl"), "existing\n")
    const sourceBefore = await readFile(join(source, "session-1.jsonl"), "utf8")
    await expect(
      migrateLegacySession({ sourceRoot: source, targetRoot: target, sessionId: "session-1" }),
    ).rejects.toMatchObject({
      code: "target_exists",
    })
    expect(await readFile(join(source, "session-1.jsonl"), "utf8")).toBe(sourceBefore)
    expect(await readFile(join(target, "session-1.jsonl"), "utf8")).toBe("existing\n")
  })

  test("an interrupted migration does not commit a target or modify the source", async () => {
    const { source, target } = await fixture()
    const sourceBefore = await readFile(join(source, "session-1.jsonl"), "utf8")
    const controller = new AbortController()
    controller.abort()
    await expect(
      migrateLegacySession({
        sourceRoot: source,
        targetRoot: target,
        sessionId: "session-1",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(SessionMigrationError)
    expect(await readFile(join(source, "session-1.jsonl"), "utf8")).toBe(sourceBefore)
    await expect(readFile(join(target, "session-1.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  test("rejects malformed or non-monotonic source records before target commit", async () => {
    const { source, target } = await fixture()
    await appendFile(
      join(source, "session-1.jsonl"),
      `${JSON.stringify({ version: 1, sessionId: "session-1", seq: 0, at: 102, type: "tool.completed" })}\n`,
    )
    await expect(
      migrateLegacySession({ sourceRoot: source, targetRoot: target, sessionId: "session-1" }),
    ).rejects.toMatchObject({
      code: "invalid_source",
    })
    await expect(readFile(join(target, "session-1.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})
