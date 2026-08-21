import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  migrateLegacySession,
  parseSessionEvidenceRecord,
  SessionMigrationError,
} from "../src/session-migration.ts"

const roots: string[] = []

afterEach(async () => {
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
