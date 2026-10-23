import { expect, test } from "bun:test"
import { NodeBodyRead } from "../src/body-read.ts"

test("a multi-chunk body is joined in order, and a map that throws rejects the read", async () => {
  const read = new NodeBodyRead(
    (body) => body.toString(),
    () => {},
  )
  read.add("one")
  read.add(Buffer.from("two"))
  read.add("three")
  expect(read.bytes().toString()).toBe("onetwothree")
  read.finish(read.bytes())
  expect(await read.result).toBe("onetwothree")

  const failing = new NodeBodyRead(
    () => {
      throw new SyntaxError("not json")
    },
    () => {},
  )
  failing.finish(failing.bytes())
  await expect(failing.result).rejects.toThrow("not json")
  const closed = new NodeBodyRead(
    (body) => body,
    () => {},
  )
  closed.fail(new Error("request closed"))
  await expect(closed.result).rejects.toThrow("request closed")
})
