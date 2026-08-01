import { describe, expect, test } from "bun:test"
import { bytes, NIFRA_BINARY_HEADER } from "../src/binary.ts"

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
    expect(response.headers.get(NIFRA_BINARY_HEADER)).toBe("1")
    expect(response.headers.get("access-control-expose-headers")).toContain(NIFRA_BINARY_HEADER)
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

  test("a name ASCII cannot carry is encoded, not thrown on", () => {
    // Setting a header containing these THREW before RFC 6266 encoding - a 500 on a download route for
    // the ordinary act of naming a file in a language ASCII does not cover, and the name is usually the
    // user's own. Bun rejects even Latin-1 `e-acute` in a header, so the fallback is printable ASCII
    // and `filename*` carries the rest.
    const cjk = bytes(PNG, { filename: "\u62a5\u544a.pdf" })
    expect(cjk.headers.get("content-disposition")).toBe(
      `attachment; filename=".pdf"; filename*=UTF-8''${encodeURIComponent("\u62a5\u544a.pdf")}`,
    )
    // The ASCII fallback keeps what it can rather than substituting a placeholder.
    const mixed = bytes(PNG, { filename: "report \u62a5\u544a.pdf" })
    expect(mixed.headers.get("content-disposition")).toContain('filename="report .pdf"')
    // An accent and an emoji are both beyond the fallback, and neither may throw.
    for (const name of ["resume\u00e9.pdf", "caf\u00e9 \u2615.png"]) {
      expect(() => bytes(PNG, { filename: name })).not.toThrow()
    }
  })

  test("malformed UTF-16 in a filename is replaced instead of throwing", () => {
    const response = bytes(PNG, { filename: "bad\ud800.pdf" })
    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''bad%EF%BF%BD.pdf",
    )
  })

  test("a sanitized ASCII name gets no second parameter", () => {
    // `filename*` exists to carry characters ASCII cannot. Emitting it for a name that merely had its
    // quotes stripped would put the attacker's string back into the header, encoded but present.
    const disposition =
      bytes(PNG, { filename: 'q1 "final".pdf' }).headers.get("content-disposition") ?? ""
    expect(disposition).toBe('attachment; filename="q1 final.pdf"')
    expect(disposition).not.toContain("filename*")
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
