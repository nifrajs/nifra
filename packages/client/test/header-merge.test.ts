import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { streaming } from "@nifrajs/core/sse"
import { richWireCodec } from "@nifrajs/core/transport-codec-rich"
import { t } from "@nifrajs/schema"
import { type ClientOptions, client, type FetchFn } from "../src/index.ts"

const app = server()
  .use(streaming())
  .get("/me", () => ({ ok: true }))
  .post("/items", { body: t.object({ a: t.number() }) }, () => ({ ok: true }))
  .sse("/events", { sse: t.number() }, (_c, stream) => stream.close())

/** Every request's headers as `Request` reads them, so a name sent twice shows up joined. */
function recorder(options: Omit<ClientOptions, "fetch"> = {}) {
  const sent: Array<Record<string, string>> = []
  const fetch: FetchFn = async (url, init) => {
    sent.push(Object.fromEntries(new Request(url, init).headers))
    return Response.json({ ok: true })
  }
  return { api: client<typeof app>("http://t", { ...options, fetch }), sent }
}

describe("header names merge in any letter case", () => {
  test("a per-call header replaces a client header of the same name", async () => {
    const { api, sent } = recorder({ headers: { Authorization: "Bearer app" } })
    await api.me.get({ headers: { authorization: "Bearer user" } })
    expect(sent[0]?.authorization).toBe("Bearer user")
  })

  test("a header onRequest returns replaces the one already set", async () => {
    const { api, sent } = recorder({
      headers: { authorization: "Bearer stale" },
      onRequest: () => ({ Authorization: "Bearer fresh" }),
    })
    await api.me.get()
    expect(sent[0]?.authorization).toBe("Bearer fresh")
  })

  test("an encoded body carries the codec's content type alone", async () => {
    const { api, sent } = recorder()
    await api.items.post({ a: 1 }, { headers: { "Content-Type": "text/plain" } })
    expect(sent[0]?.["content-type"]).toBe("application/json")
  })

  test("an accept set by the caller is kept over the codec's", async () => {
    const { api, sent } = recorder({ transport: { codec: richWireCodec() } })
    await api.items.post({ a: 1 }, { headers: { Accept: "application/json" } })
    expect(sent[0]?.accept).toBe("application/json")
  })

  test("a subscription sends one value for each name", async () => {
    let sent: Record<string, string> = {}
    const { promise: connected, resolve } = Promise.withResolvers<void>()
    const api = client<typeof app>("http://t", {
      headers: { Authorization: "Bearer app" },
      fetch: async (url, init) => {
        sent = Object.fromEntries(new Request(url, init).headers)
        resolve()
        return new Response("", { headers: { "content-type": "text/event-stream" } })
      },
    })
    const subscription = api.events.subscribe(() => {}, {
      headers: { authorization: "Bearer user", Accept: "application/json" },
      reconnect: false,
    })
    await connected
    subscription.close()
    expect(sent.authorization).toBe("Bearer user")
    expect(sent.accept).toBe("text/event-stream")
  })
})
