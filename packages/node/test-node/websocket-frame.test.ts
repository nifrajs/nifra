/**
 * The publish fast path against the `ws` the adapter runs with, not a stand-in: it reads `ws`'s own
 * sender state, so a `ws` release that changes that state must fail here rather than turn the path off
 * unnoticed, or interleave frames.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { WebSocket, WebSocketServer } from "ws"
import { writeTextFrame } from "../src/ws-frame.ts"

/** A server-side socket from `ws`, and every text its client has read so far. */
async function connected(deflate: boolean) {
  const wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    perMessageDeflate: deflate ? { threshold: 0 } : false,
  })
  await new Promise((resolve) => wss.once("listening", resolve))
  const address = wss.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  const accepted = new Promise<WebSocket>((resolve) => wss.once("connection", resolve))
  const client = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: deflate })
  const got: string[] = []
  let waiting: { readonly count: number; readonly resolve: (texts: string[]) => void } | undefined
  client.on("message", (data: Buffer, isBinary: boolean) => {
    got.push(isBinary ? "<binary>" : data.toString())
    if (waiting !== undefined && got.length >= waiting.count) waiting.resolve([...got])
  })
  await new Promise((resolve, reject) => {
    client.once("open", resolve)
    client.once("error", reject)
  })
  const socket = await accepted
  return {
    socket,
    received: (count: number): Promise<string[]> =>
      got.length >= count
        ? Promise.resolve([...got])
        : new Promise((resolve) => {
            waiting = { count, resolve }
          }),
    close: () => {
      client.terminate()
      wss.close()
    },
  }
}

for (const deflate of [false, true]) {
  const name = deflate ? "permessage-deflate" : "no extension"
  test(`an idle ws sender takes the pre-built frame (${name})`, async () => {
    const pair = await connected(deflate)
    try {
      assert.equal(pair.socket.extensions.includes("permessage-deflate"), deflate)
      pair.socket.send("through ws")
      await pair.received(1)
      // Uncompressed on a compressing connection too: RFC 7692 lets a sender leave a message plain.
      assert.equal(writeTextFrame(pair.socket, "pre-built é 😀"), true)
      assert.deepEqual(await pair.received(2), ["through ws", "pre-built é 😀"])
    } finally {
      pair.close()
    }
  })

  test(`frames from both paths arrive whole and in order (${name})`, async () => {
    const pair = await connected(deflate)
    try {
      const sent: string[] = []
      for (let i = 0; i < 600; i++) {
        // Every length class of the frame header, and text that is not ASCII.
        const text =
          i % 7 === 0 ? `big-${i}-`.repeat(9000) : i % 5 === 0 ? `m${i}`.repeat(40) : `m${i}-é`
        sent.push(text)
        if (i % 3 === 0 || !writeTextFrame(pair.socket, text)) pair.socket.send(text)
      }
      assert.deepEqual(await pair.received(sent.length), sent)
    } finally {
      pair.close()
    }
  })
}
