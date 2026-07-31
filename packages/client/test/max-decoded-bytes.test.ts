import { describe, expect, test } from "bun:test"
import { type ClientOptions, client } from "@nifrajs/client"
import { server } from "@nifrajs/core"

/**
 * The response size limit, and the one body it deliberately does not apply to.
 *
 * `maxBytes` bounded JSON only, was undocumented, and - the part that made it worse than a gap - could
 * not be set at all by an ordinary app: it lived under `transport`, whose `codec` is required, so
 * raising your response limit meant opting into a versioned transport representation you had not asked
 * for. The 16 MB default protected everyone while the knob was reachable by nobody.
 *
 * It is a top-level option now, it bounds text as well as JSON, and a download is exempt on purpose.
 */

const big = (n: number): string => "x".repeat(n)

const call = async (
  app: { fetch: (request: Request) => Response | Promise<Response> },
  options: ClientOptions,
): Promise<{ ok: boolean; status: number; data: unknown; error: unknown }> => {
  const api = client<never>("http://limit.test", {
    fetch: (url, init) => Promise.resolve(app.fetch(new Request(url, init))),
    ...options,
  }) as unknown as Record<
    string,
    { get: () => Promise<{ ok: boolean; status: number; data: unknown; error: unknown }> }
  >
  const route = api.x
  if (route === undefined) throw new Error("no client route")
  return await route.get()
}

describe("maxDecodedBytes", () => {
  test("is reachable without opting into a transport codec", async () => {
    // The whole defect in one line: this call did not compile before, because `transport` required a
    // `codec`. A type-level regression guard lives beside this; the runtime half is here.
    const app = server().get("/x", () => ({ s: big(5_000) }))
    const res = await call(app, { maxDecodedBytes: 1_000 })
    expect(res.ok).toBe(false)
  })

  test("a breach is a RESULT, never a throw", async () => {
    // The client's one promise. A cap that threw would mean the only safe way to use it was the
    // try/catch the contract exists to remove - and it did throw, out of every oversized JSON call.
    const app = server().get("/x", () => ({ s: big(5_000) }))
    const res = await call(app, { maxDecodedBytes: 1_000 })
    expect(res).toEqual({
      ok: false,
      status: 0,
      data: null,
      error: { error: "response_too_large" },
    })
  })

  test("bounds a JSON body", async () => {
    const app = server().get("/x", () => ({ s: big(5_000) }))
    expect((await call(app, { maxDecodedBytes: 1_000 })).ok).toBe(false)
    expect((await call(app, { maxDecodedBytes: 1_000_000 })).ok).toBe(true)
  })

  test("bounds a text body with the same number", async () => {
    // Previously unbounded. A 2 GB string costs what a 2 GB object costs, so one limit answers for both.
    const app = server().get(
      "/x",
      () => new Response(big(5_000), { headers: { "content-type": "text/plain" } }),
    )
    expect((await call(app, { maxDecodedBytes: 1_000 })).ok).toBe(false)
    expect((await call(app, { maxDecodedBytes: 1_000_000 })).data).toBe(big(5_000))
  })

  test("does NOT bound a download", async () => {
    // A size limit on a download is a bug, not a defence - the caller asked for the file. This is the
    // assertion that says so, and it is the reason the option is named for DECODING.
    const app = server().get(
      "/x",
      () =>
        new Response(new Uint8Array(5_000), {
          headers: { "content-type": "application/octet-stream" },
        }),
    )
    const res = await call(app, { maxDecodedBytes: 1_000 })
    expect(res.ok).toBe(true)
    expect((res.data as Blob).size).toBe(5_000)
  })

  test("the older transport.maxBytes spelling still decides the transport path", async () => {
    const app = server().get("/x", () => ({ s: big(5_000) }))
    const res = await call(app, {
      maxDecodedBytes: 1_000_000,
      transport: { codec: undefined as never, maxBytes: 1_000 },
    })
    expect(res.ok).toBe(false)
  })

  test("a malformed text body still decodes leniently rather than failing", async () => {
    // `.text()` substitutes U+FFFD for a bad sequence and callers have always seen that. Bounding the
    // read must not smuggle in a stricter decode that turns working responses into errors.
    const app = server().get(
      "/x",
      () =>
        new Response(new Uint8Array([0xff, 0x41]), { headers: { "content-type": "text/plain" } }),
    )
    const res = await call(app, {})
    expect(res.ok).toBe(true)
    expect(res.data).toBe("�A")
  })
})
