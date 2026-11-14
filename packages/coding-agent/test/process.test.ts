import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readBoundedText, runBoundedProcess } from "../src/process.ts"

const encoder = new TextEncoder()

function chunks(...parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(source) {
      for (const part of parts) source.enqueue(encoder.encode(part))
      source.close()
    },
  })
}

test("an abort stops the read with what arrived so far, even when cancelling the source fails", async () => {
  const controller = new AbortController()
  const waiting = Promise.withResolvers<void>()
  let pulls = 0
  // One chunk, then a source that never ends on its own, like a pipe a stray process holds open.
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(source) {
        pulls += 1
        if (pulls === 1) {
          source.enqueue(encoder.encode("partial"))
          return
        }
        waiting.resolve()
        return new Promise(() => {})
      },
      cancel() {
        throw new Error("cancel failed")
      },
    },
    { highWaterMark: 0 },
  )
  const reading = readBoundedText(stream, 1024, controller.signal)
  await waiting.promise
  controller.abort()
  expect(await reading).toEqual({ text: "partial", truncated: false })
})

test("an already aborted signal reads nothing", async () => {
  expect(await readBoundedText(chunks("late"), 1024, AbortSignal.abort())).toEqual({
    text: "",
    truncated: false,
  })
})

test("a chunk after the cap is filled exactly marks the text truncated", async () => {
  expect(await readBoundedText(chunks("abcd", "e"), 4)).toEqual({ text: "abcd", truncated: true })
  expect(await readBoundedText(chunks("abcd"), 4)).toEqual({ text: "abcd", truncated: false })
})

test.skipIf(process.platform === "win32")(
  "a process the child left running is ended with it, and its open pipes no longer hold the call",
  async () => {
    const ground = await mkdtemp(join(tmpdir(), "nifra-process-test-"))
    try {
      // The descendant announces SIGTERM on stderr and exits; it holds both pipes, so the call can only
      // finish by reading to their end, and the text proves the signal reached it rather than a timer.
      // The shell waits for the handler to be installed before it exits.
      const descendant =
        'process.on("SIGTERM", () => { console.error("termed"); process.exit(0) });' +
        'await Bun.write("ready", ""); setInterval(() => {}, 1000)'
      const script = '"$BUN" -e "$CODE" &\nwhile [ ! -e ready ]; do :; done\nprintf done'
      const result = await runBoundedProcess(["sh", "-c", script], {
        cwd: ground,
        env: { PATH: process.env.PATH ?? "", BUN: process.execPath, CODE: descendant },
        timeoutMs: 120_000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
      })
      expect(result.status).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.stdout.text).toBe("done")
      expect(result.stderr.text).toBe("termed\n")
    } finally {
      await rm(ground, { recursive: true, force: true })
    }
  },
  20_000,
)

test.skipIf(process.platform === "win32")(
  "a descendant that ignores SIGTERM is still killed when the caller's process exits right after",
  async () => {
    const ground = await mkdtemp(join(tmpdir(), "nifra-process-test-"))
    try {
      const descendant =
        'process.on("SIGTERM", () => {}); await Bun.write("pid", String(process.pid));' +
        "setInterval(() => {}, 1000)"
      const runner =
        `import { runBoundedProcess } from ${JSON.stringify(join(import.meta.dir, "../src/process.ts"))};` +
        'await runBoundedProcess(["sh", "-c", \'"$BUN" -e "$CODE" >/dev/null 2>&1 &\\nwhile [ ! -e pid ]; do :; done\'], ' +
        `{ cwd: ${JSON.stringify(ground)}, env: { PATH: process.env.PATH ?? "", BUN: process.execPath, CODE: process.env.CODE ?? "" }, ` +
        "timeoutMs: 120000, maxStdoutBytes: 1024, maxStderrBytes: 1024 })"
      const parent = Bun.spawn([process.execPath, "-e", runner], {
        env: { PATH: process.env.PATH ?? "", CODE: descendant },
        stdout: "ignore",
        stderr: "inherit",
      })
      expect(await parent.exited).toBe(0)
      const pid = Number(await Bun.file(join(ground, "pid")).text())
      let alive = true
      for (let i = 0; i < 40 && alive; i++) {
        try {
          process.kill(pid, 0)
          await Bun.sleep(25)
        } catch {
          alive = false
        }
      }
      expect(alive).toBe(false)
    } finally {
      await rm(ground, { recursive: true, force: true })
    }
  },
  20_000,
)

test.skipIf(process.platform === "win32")(
  "a descendant that ignores SIGTERM is killed at the end of the grace, and holding the pipes does not hold the call",
  async () => {
    const ground = await mkdtemp(join(tmpdir(), "nifra-process-test-"))
    try {
      const descendant =
        'process.on("SIGTERM", () => {}); await Bun.write("pid", String(process.pid));' +
        "setInterval(() => {}, 1000)"
      const script = '"$BUN" -e "$CODE" &\nwhile [ ! -e pid ]; do :; done'
      await runBoundedProcess(["sh", "-c", script], {
        cwd: ground,
        env: { PATH: process.env.PATH ?? "", BUN: process.execPath, CODE: descendant },
        timeoutMs: 120_000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
      })
      const pid = Number(await Bun.file(join(ground, "pid")).text())
      process.kill(pid, 0)
      let alive = true
      for (let i = 0; i < 160 && alive; i++) {
        await Bun.sleep(25)
        try {
          process.kill(pid, 0)
        } catch {
          alive = false
        }
      }
      expect(alive).toBe(false)
    } finally {
      await rm(ground, { recursive: true, force: true })
    }
  },
  20_000,
)
