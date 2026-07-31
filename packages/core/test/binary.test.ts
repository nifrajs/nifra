import { describe, expect, test } from "bun:test"
import { bytes } from "../src/binary.ts"

/**
 * `bytes()` is how a route says its payload IS the body.
 *
 * Sending bytes has always been possible - return a raw `Response` - but a raw `Response` is what the
 * typed client cannot describe, so a download route needed a `// nifra-expect raw-response` pragma to
 * quiet the advisory and gave its caller no type at all. This is the declaration that closes that,
 * and the brand it carries is a phantom: nothing is added to the value at runtime.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xd8])

describe("bytes", () => {
  test("sends the body unchanged, with the declared media type", async () => {
    const response = bytes(PNG, { type: "image/png" })
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
  })

  test("unlabelled bytes are octet-stream, not guessed", async () => {
    expect(bytes(PNG).headers.get("content-type")).toBe("application/octet-stream")
  })

  test("a filename offers the body as a download", () => {
    expect(bytes(PNG, { filename: "invoice.pdf" }).headers.get("content-disposition")).toBe(
      'attachment; filename="invoice.pdf"',
    )
  })

  test("a filename cannot write its own header parameters", () => {
    // The ordinary case is a name derived from user data - an upload's original name, a document
    // title - so a quote or a newline in one has to be inert rather than trusted.
    const hostile = bytes(PNG, { filename: 'q1 "final".pdf"; attachment; filename="evil.exe' })
    const disposition = hostile.headers.get("content-disposition") ?? ""
    expect(disposition).toBe('attachment; filename="q1 final.pdf; attachment; filename=evil.exe"')
    // One `filename=` parameter, and the whole value stays inside one pair of quotes.
    expect(disposition.match(/"/g)).toHaveLength(2)
  })

  test("a CRLF in a filename cannot split the header", () => {
    const injected = bytes(PNG, { filename: "a\r\nSet-Cookie: admin=1" })
    expect(injected.headers.get("content-disposition")).not.toContain("\n")
    expect(injected.headers.get("set-cookie")).toBeNull()
  })

  test("status and extra headers pass through", () => {
    const response = bytes(PNG, { status: 206, headers: { "cache-control": "public, max-age=60" } })
    expect(response.status).toBe(206)
    expect(response.headers.get("cache-control")).toBe("public, max-age=60")
  })

  test("the content type wins over a hand-passed one, so the declaration is the truth", () => {
    // Otherwise a stale `headers` entry could disagree with `type` and the client would decode by the
    // wrong one - the media type is what decides whether a body is text or bytes.
    const response = bytes(PNG, { type: "image/png", headers: { "content-type": "text/plain" } })
    expect(response.headers.get("content-type")).toBe("image/png")
  })

  test("every body shape the Response constructor takes", async () => {
    for (const body of [PNG, PNG.buffer, new Blob([PNG])]) {
      const response = bytes(body as Parameters<typeof bytes>[0])
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
    }
  })
})
