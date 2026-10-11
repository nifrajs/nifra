import { expect, test } from "bun:test"
import { writeRpc } from "../src/rpc-write.ts"

test("RPC writes wait for the pipe flush and preserve the JSONL frame", async () => {
  let release: () => void = () => {}
  const flush = new Promise<void>((resolve) => {
    release = resolve
  })
  let frame = ""
  let settled = false
  const writing = writeRpc(
    {
      write: (data) => {
        frame = data
      },
      flush: () => flush,
    },
    { type: "abort" },
  ).then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(frame).toBe('{"type":"abort"}\n')
  expect(settled).toBe(false)
  release()
  await writing
  expect(settled).toBe(true)
})

test("an asynchronous broken-pipe flush is returned to the caller", async () => {
  const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" })
  await expect(writeRpc({ write: () => {}, flush: () => Promise.reject(error) }, {})).rejects.toBe(
    error,
  )
})

test("an unavailable pipe or synchronous write failure is returned to the caller", async () => {
  for (const stdin of [undefined, null, 1]) {
    await expect(writeRpc(stdin, {})).rejects.toThrow("stdin is unavailable")
  }
  const error = new Error("closed")
  await expect(
    writeRpc(
      {
        write: () => {
          throw error
        },
        flush: () => 0,
      },
      {},
    ),
  ).rejects.toBe(error)
})
