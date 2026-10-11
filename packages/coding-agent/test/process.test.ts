import { expect, test } from "bun:test"
import { readBoundedText } from "../src/process.ts"

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
