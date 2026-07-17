import { afterEach, describe, expect, test } from "bun:test"
import { client, testClient } from "@nifrajs/client"
import type { RunningServer, StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"

function schema<O>(validate: (value: unknown) => StandardResult<O>): StandardSchemaV1<unknown, O> {
  return {
    "~standard": {
      version: 1,
      vendor: "nifra-test",
      validate,
      types: undefined as unknown as StandardTypes<unknown, O>,
    },
  }
}

const chatIn = schema<{ say: string }>((v) =>
  typeof v === "object" &&
  v !== null &&
  "say" in v &&
  typeof (v as { say: unknown }).say === "string"
    ? { value: { say: (v as { say: string }).say } }
    : { issues: [{ message: "say must be a string", path: ["say"] }] },
)
const chatOut = schema<{ echoed: string; at: number }>((v) => ({
  value: v as { echoed: string; at: number },
}))

const app = server()
  .use(websocket())
  .get("/health", () => ({ ok: true }))
  .ws("/chat", {
    messageSchema: chatIn,
    sendSchema: chatOut,
    message: (ws, data) => {
      ws.send(JSON.stringify({ echoed: data.say, at: 1 }))
    },
  })

let running: RunningServer | undefined
afterEach(() => {
  running?.stop(true)
  running = undefined
})

describe("typed client .ws()", () => {
  test("send/messages round-trip a typed frame over a real socket", async () => {
    running = app.listen(0)
    const api = client<typeof app>(`http://127.0.0.1:${running.port}`)

    const chat = api.chat.ws()
    chat.send({ say: "hello" }) // queued until open - must not throw
    await chat.opened

    const iterator = chat.messages()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value).toEqual({ echoed: "hello", at: 1 })

    chat.close()
    const end = await iterator.next()
    expect(end.done).toBe(true)
  })

  test("onMessage callback form delivers parsed frames and unsubscribes", async () => {
    running = app.listen(0)
    const api = client<typeof app>(`http://127.0.0.1:${running.port}`)
    const chat = api.chat.ws()

    const got: unknown[] = []
    const stop = chat.onMessage((m) => got.push(m))
    chat.send({ say: "one" })
    await chat.opened
    // Wait for the frame to arrive.
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (got.length > 0) {
          clearInterval(t)
          resolve()
        }
      }, 5)
    })
    expect(got).toEqual([{ echoed: "one", at: 1 }])
    stop()
    chat.close()
  })

  test("a schema-invalid inbound frame is dropped by the server, not echoed", async () => {
    running = app.listen(0)
    const api = client<typeof app>(`http://127.0.0.1:${running.port}`)
    const chat = api.chat.ws()
    await chat.opened

    // Bypass the typed surface to send a frame the messageSchema rejects.
    chat.raw.send(JSON.stringify({ not: "the contract" }))
    chat.send({ say: "after" })

    const iterator = chat.messages()
    const first = await iterator.next()
    // Only the valid frame comes back - the invalid one never reached the handler.
    expect(first.value).toEqual({ echoed: "after", at: 1 })
    chat.close()
  })

  test("the in-process client refuses .ws() with a real explanation", () => {
    const api = testClient<typeof app>(app)
    expect(() => api.chat.ws()).toThrow(/in-process client cannot open WebSockets/)
  })
})
