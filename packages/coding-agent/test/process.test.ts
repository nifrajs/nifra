import { expect, test } from "bun:test"
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
  "a child that exits while a process it started holds stdout open settles without timing out",
  async () => {
    // The background sleep inherits both pipes and outlives the shell; its pid goes to stderr.
    const result = await runBoundedProcess(["sh", "-c", "printf done; sleep 60 & echo $! >&2"], {
      cwd: import.meta.dir,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 120_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
    })
    try {
      expect(result.status).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.stdout.text).toBe("done")
    } finally {
      const pid = Number(result.stderr.text.trim())
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid)
    }
  },
  20_000,
)
