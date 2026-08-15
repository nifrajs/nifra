import { describe, expect, test } from "bun:test"
import {
  RESERVED_EXACT_KEYS,
  RESERVED_KEY_READOUT,
  RESERVED_VERB_KEYS,
  reservedKeyFor,
  testClient,
} from "@nifrajs/client"
import { server } from "@nifrajs/core"

/**
 * `reserved.ts` is what the types, the runtime proxy, and the `nifra check` lint all claim to
 * agree on. Comparing the lists to each other would only prove they were copied consistently, so
 * these tests drive the REAL proxy instead: for every key the list calls reserved, the proxy must
 * resolve the reserved behavior rather than a path segment, and for a name that is not on the list
 * it must resolve the path. A key silently losing its interception fails here even if every list
 * still reads the same.
 */

describe("reserved key list is in lockstep with the runtime proxy", () => {
  /**
   * A decoy route at `/things/<verb>` for every reserved verb. If the proxy ever stopped
   * intercepting one, the request would land on the decoy and say so - which is what makes this a
   * lockstep proof rather than a smoke test.
   */
  const decoyApp = () =>
    server()
      .get("/things/get", () => ({ via: "path" }))
      .get("/things/head", () => ({ via: "path" }))
      .get("/things/options", () => ({ via: "path" }))
      .get("/things/post", () => ({ via: "path" }))
      .get("/things/put", () => ({ via: "path" }))
      .get("/things/patch", () => ({ via: "path" }))
      .get("/things/delete", () => ({ via: "path" }))
      .get("/things", () => ({ via: "verb" }))
      .post("/things", () => ({ via: "verb" }))
      .put("/things", () => ({ via: "verb" }))
      .patch("/things", () => ({ via: "verb" }))
      .delete("/things", () => ({ via: "verb" }))

  test.each([...RESERVED_VERB_KEYS])("`%s` resolves the verb, not a path segment", async (verb) => {
    const app = decoyApp()
    const api = testClient<typeof app>(app) as unknown as Record<
      string,
      Record<string, (() => Promise<{ ok: boolean; data: unknown }>) | undefined>
    >
    const call = api.things?.[verb]
    if (call === undefined) throw new Error(`proxy has no \`${verb}\` key`)
    const res = await call()
    // `head` and `options` have no server builder method (the router answers them itself), so the
    // proof for those two is that the decoy at `/things/<verb>` was NOT what answered.
    if (verb === "head" || verb === "options") expect(res.data).not.toEqual({ via: "path" })
    else expect(res).toMatchObject({ ok: true, data: { via: "verb" } })
  })

  test("`index` addresses the parent path and adds no segment", async () => {
    const app = server()
      .get("/things", () => ({ via: "index" }))
      .get("/things/index", () => ({ via: "path" }))
    // The decoy makes `index` a colliding static child, so the TYPE rejects `.index` here - which is
    // itself the contract. The cast asserts what the RUNTIME does with the access.
    const api = testClient<typeof app>(app) as unknown as {
      things: { index: { get(): Promise<{ ok: boolean; data: unknown }> } }
    }
    const res = await api.things.index.get()
    expect(res).toMatchObject({ ok: true, data: { via: "index" } })
  })

  test("`then` is guarded, so awaiting a node never resolves it as a path", async () => {
    const app = server().get("/things/then", () => ({ via: "path" }))
    const api = testClient<typeof app>(app)
    // Without the guard this await would treat the node as a thenable and hang or misresolve.
    const node = await (api.things as unknown)
    expect(node).toBeDefined()
  })

  test.each(["subscribe", "ws"] as const)("`%s` resolves a transport, not a path", (key) => {
    const app = server().get("/things", () => ({ ok: true }))
    const api = testClient<typeof app>(app) as unknown as Record<string, Record<string, unknown>>
    // The transport factories are functions; a path node is a callable proxy too, so the proof is
    // that they are NOT the proxy - a path node exposes the verb keys, a transport factory does not.
    const resolved = api.things?.[key] as Record<string, unknown> | undefined
    expect(typeof resolved).toBe("function")
    expect((resolved as Record<string, unknown>).get).toBeUndefined()
  })

  test("a name that is not reserved resolves as a path segment", async () => {
    // The control: without this, a proxy that intercepted EVERYTHING would pass every test above.
    const app = server().get("/things/remove", () => ({ via: "path" }))
    const api = testClient<typeof app>(app)
    expect((await api.things.remove.get()).data).toEqual({ via: "path" })
  })
})

describe("reservedKeyFor", () => {
  test("matches verbs case-insensitively and exact keys exactly", () => {
    expect(reservedKeyFor("Delete")).toBe("delete")
    expect(reservedKeyFor("DELETE")).toBe("delete")
    expect(reservedKeyFor("subscribe")).toBe("subscribe")
    // Exact keys are compared exactly by the proxy, so `Subscribe` reaches the PATH and is fine.
    expect(reservedKeyFor("Subscribe")).toBeUndefined()
    expect(reservedKeyFor("remove")).toBeUndefined()
  })

  test("a param or wildcard segment never collides", () => {
    // These are never spelled as property accesses, so no reserved key can shadow them.
    expect(reservedKeyFor(":delete")).toBeUndefined()
    expect(reservedKeyFor("*then")).toBeUndefined()
  })

  test("the readout names every reserved key, so a diagnostic quoting it stays complete", () => {
    for (const key of [...RESERVED_VERB_KEYS, ...RESERVED_EXACT_KEYS])
      expect(RESERVED_KEY_READOUT).toContain(key)
  })
})
