import { describe, expect, test } from "bun:test"
import { client } from "@nifrajs/client"
import { server } from "@nifrajs/core"
import { bytes } from "@nifrajs/core/binary"

/**
 * A binary body has to survive the client.
 *
 * `parseBody` handled JSON and then fell back to `.text()` for everything else, and decoding bytes as
 * UTF-8 does not fail - it SUBSTITUTES. Every invalid sequence became U+FFFD, so a PNG came back as a
 * string of replacement characters that could never be turned back into the image:
 *
 *     sent      89 50 4e 47 ff d8
 *     received  ef bf bd 50 4e 47 ef bf bd ef bf bd
 *
 * Which is worse than refusing the body, because it looks like a broken file rather than a broken
 * client. The rule now follows the media type: JSON decodes, text decodes, everything else is a Blob.
 */

/** A PNG signature plus two bytes that are not valid UTF-8 on their own - the whole point. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0x00, 0x7f])

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ")

/** Drive the real client over the app's own fetch, so this is the path an app takes. */
const call = async (
  app: { fetch: (request: Request) => Response | Promise<Response> },
  segment: string,
): Promise<{ ok: boolean; data: unknown }> => {
  const api = client<never>("http://binary.test", {
    fetch: (url, init) => Promise.resolve(app.fetch(new Request(url, init))),
  }) as unknown as Record<string, { get: () => Promise<{ ok: boolean; data: unknown }> }>
  const route = api[segment]
  if (route === undefined) throw new Error(`no client route for ${segment}`)
  return await route.get()
}

describe("binary responses", () => {
  test("bytes arrive byte-identical, as a Blob", async () => {
    const app = server().get(
      "/avatar",
      () => new Response(PNG, { headers: { "content-type": "image/png" } }),
    )
    const res = await call(app, "avatar")

    expect(res.ok).toBe(true)
    expect(res.data).toBeInstanceOf(Blob)
    const received = new Uint8Array(await (res.data as Blob).arrayBuffer())
    // Byte equality, not length - the corruption this replaces preserved length while destroying every
    // non-ASCII byte, so a length check would have passed against the bug.
    expect(hex(received)).toBe(hex(PNG))
  })

  test("a Blob carries its media type, so a caller can save or render it", async () => {
    const app = server().get(
      "/doc",
      () => new Response(PNG, { headers: { "content-type": "application/pdf" } }),
    )
    const res = await call(app, "doc")
    expect((res.data as Blob).type).toBe("application/pdf")
  })

  test("bytes() stays a Blob even when its declared media type is textual", async () => {
    const payload = new TextEncoder().encode('{"looks":"json"}')
    const app = server()
      .get("/text", () => bytes(payload, { type: "text/plain" }))
      .get("/json", () => bytes(payload, { type: "application/json" }))

    for (const route of ["text", "json"]) {
      const res = await call(app, route)
      expect(res.data).toBeInstanceOf(Blob)
      expect(new Uint8Array(await (res.data as Blob).arrayBuffer())).toEqual(payload)
    }
  })
})

/**
 * The text side is what this must not disturb. Every one of these decoded to a string before and has
 * to keep doing so - a Blob here would break callers that read the body today.
 */
describe("textual responses still decode to text", () => {
  const textual: ReadonlyArray<readonly [string, string]> = [
    ["text/plain", "hello"],
    ["text/csv", "a,b\n1,2"],
    ["text/html", "<p>hi</p>"],
    // `+xml` and `+json` are textual by the `+suffix` convention. An SVG is a document, and handing
    // one back as a Blob would break anyone reading it as markup.
    ["image/svg+xml", "<svg/>"],
    ["application/xml", "<a/>"],
    ["application/javascript", "export const a = 1"],
    // A charset parameter must not change the decision.
    ["text/plain; charset=utf-8", "hello"],
  ]

  for (const [type, body] of textual) {
    test(type, async () => {
      const app = server().get(
        "/x",
        () => new Response(body, { headers: { "content-type": type } }),
      )
      const res = await call(app, "x")
      expect(res.data).toBe(body)
    })
  }

  test("an unlabelled body is still parsed as JSON-or-text", async () => {
    // What a hand-written `new Response("…")` produces. Guessing "binary" for an unlabelled body would
    // change far more than this is meant to, so absent means textual.
    const app = server().get("/x", () => new Response('{"n":1}'))
    const res = await call(app, "x")
    expect(res.data).toEqual({ n: 1 })
  })

  test("a JSON route is untouched", async () => {
    const app = server().get("/x", () => ({ n: 1 }))
    const res = await call(app, "x")
    expect(res.data).toEqual({ n: 1 })
  })
})
