import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeBodyRead } from "../src/body-read.ts"

test("single chunks keep their identity and multi-chunk bodies preserve bytes", async () => {
  const chunk = Buffer.from("one")
  const read = new NodeBodyRead(
    (body) => body.toString(),
    () => {},
  )
  read.add(chunk)
  assert.equal(read.bytes(), chunk)
  read.add(Buffer.from("two"))
  assert.equal(read.bytes().toString(), "onetwo")
  read.finish(read.bytes())
  assert.equal(await read.result, "onetwo")
})

test("empty, string, and interleaved readers retain independent state", async () => {
  const a = new NodeBodyRead(
    (body) => body.toString(),
    () => {},
  )
  const b = new NodeBodyRead(
    (body) => body.toString(),
    () => {},
  )
  const empty = new NodeBodyRead(
    (body) => body.length,
    () => {},
  )
  a.add("A")
  b.add("B")
  a.add("\u{1f30d}")
  b.add("two")
  for (const read of [a, b]) read.finish(read.bytes())
  empty.finish(empty.bytes())
  assert.deepEqual(await Promise.all([a.result, b.result, empty.result]), ["A\u{1f30d}", "Btwo", 0])
})

test("mapping errors and socket errors reject their original promises", async () => {
  const error = new Error("parse failed")
  const mapping = new NodeBodyRead(
    () => {
      throw error
    },
    () => {},
  )
  mapping.finish(Buffer.from("{"))
  await assert.rejects(mapping.result, (actual) => actual === error)
  const socket = new NodeBodyRead(
    (body) => body,
    () => {},
  )
  socket.fail(error)
  await assert.rejects(socket.result, (actual) => actual === error)
})
