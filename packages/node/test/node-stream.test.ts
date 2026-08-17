import { expect, test } from "bun:test"
import { Readable } from "node:stream"
import { claimableWebStream, claimNodeStream, NODE_STREAM_CLAIM } from "../src/node-stream.ts"

/** Wait a macrotask so a source's async `destroy()`/drain has run before asserting. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A Node `Readable` that yields `chunks` and records whether it was destroyed. */
function sourceOf(...chunks: string[]): Readable {
  return Readable.from(chunks.map((c) => Buffer.from(c)))
}

test("reads a Node source through the Web view, chunk for chunk", async () => {
  const web = claimableWebStream(sourceOf("ab", "cd"))
  const reader = web.getReader()
  const first = await reader.read()
  const second = await reader.read()
  const end = await reader.read()
  expect(new TextDecoder().decode(first.value)).toBe("ab")
  expect(new TextDecoder().decode(second.value)).toBe("cd")
  expect(end.done).toBe(true)
})

test("an object-mode chunk (non-binary) is rejected, never enqueued", async () => {
  const source = Readable.from([{ not: "bytes" }], { objectMode: true })
  const web = claimableWebStream(source)
  const reader = web.getReader()
  await expect(reader.read()).rejects.toThrow(/non-binary chunk/)
})

test("destroy policy: cancelling releases the source at once", async () => {
  const source = sourceOf("x".repeat(1024))
  const web = claimableWebStream(source, "destroy")
  await web.cancel()
  await tick()
  expect(source.destroyed).toBe(true)
})

test("drain policy, source untouched: cancel resumes then destroys on end", async () => {
  const source = sourceOf("one", "two", "three")
  const web = claimableWebStream(source, "drain")
  // No read happened, so no iterator/`readable` listener yet: the resume() drain applies.
  await web.cancel()
  await tick()
  await tick()
  expect(source.destroyed).toBe(true)
})

test("drain policy, source already iterated: cancel pumps the iterator to the end", async () => {
  const source = sourceOf("one", "two", "three", "four")
  const web = claimableWebStream(source, "drain")
  const reader = web.getReader()
  // First read attaches the async iterator (and its `readable` listener), the state where
  // resume() is a no-op and the drain must pump the iterator itself.
  await reader.read()
  await reader.cancel()
  await tick()
  await tick()
  expect(source.destroyed).toBe(true)
})

test("claimNodeStream hands back the untouched Node source exactly once", () => {
  const source = sourceOf("payload")
  const web = claimableWebStream(source, "drain")
  const claimed = claimNodeStream(web)
  expect(claimed).toBe(source)
  // One-shot: a second claim yields nothing.
  expect(claimNodeStream(web)).toBeNull()
})

test("a source that was already read cannot be claimed", async () => {
  const source = sourceOf("payload")
  const web = claimableWebStream(source, "drain")
  const reader = web.getReader()
  await reader.read()
  reader.releaseLock()
  // A pull happened, so bytes are gone: the claim refuses rather than hand back a short body.
  expect(claimNodeStream(web)).toBeNull()
})

test("claimNodeStream refuses a foreign or locked stream", () => {
  const plain = new ReadableStream<Uint8Array>()
  expect(claimNodeStream(plain)).toBeNull()
  expect(claimNodeStream(null)).toBeNull()

  const web = claimableWebStream(sourceOf("x"), "drain")
  web.getReader() // locks it
  expect(claimNodeStream(web)).toBeNull()
})

test("a spoofed claim holder returning a non-Readable is rejected", () => {
  const fake = new ReadableStream<Uint8Array>() as ReadableStream<Uint8Array> & {
    [NODE_STREAM_CLAIM]?: { claim(): unknown }
  }
  Object.defineProperty(fake, NODE_STREAM_CLAIM, {
    value: { claim: () => ({ not: "a readable" }) },
    enumerable: false,
  })
  expect(claimNodeStream(fake)).toBeNull()
})
