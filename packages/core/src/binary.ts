/**
 * `@nifrajs/core/binary` - a route that returns bytes, and says so in its type.
 *
 * A download route had no way to be part of the contract. Returning a raw `Response` is the only way
 * to send bytes, and a raw `Response` is exactly what the typed client cannot describe - so the route
 * needed a `// nifra-expect raw-response` pragma to quiet the advisory, and its caller got no type at
 * all. One whole category of endpoint sat outside the thing the framework is otherwise strict about.
 *
 *     import { bytes } from "@nifrajs/core/binary"
 *
 *     app.get("/invoice.pdf", async (c) => bytes(await render(c.params.id), {
 *       type: "application/pdf",
 *       filename: "invoice.pdf",
 *     }))
 *
 * The client types `data` as `Blob` for that route, and gets the bytes intact.
 *
 * The brand is a phantom: `bytes()` returns a real `Response` and nothing is added to it at runtime.
 * It exists so the type carries a fact the value cannot - that these bytes are the payload rather than
 * a serialization accident - which is what lets `Jsonify` answer `Blob` instead of trying to describe
 * a `Response`'s properties.
 */

/**
 * Marker on a binary response's TYPE. A unique symbol rather than a string key, so no ordinary object
 * can satisfy it by accident, and declared required rather than optional - an optional brand is
 * satisfied by every type that lacks it, which would make the check match `Response` itself.
 */
declare const NIFRA_BYTES: unique symbol

/** Runtime marker paired with the type-only brand so clients do not have to guess from media type. */
export const NIFRA_BINARY_HEADER = "x-nifra-binary"

/** A `Response` a route declared as binary. `Jsonify` maps this to `Blob`. */
export type BinaryResponse = Response & { readonly [NIFRA_BYTES]: true }

/** What can be sent as bytes without being re-encoded on the way out. */
export type BinaryBody = ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array>

export interface BytesOptions {
  /** Media type. Defaults to `application/octet-stream`, the honest answer for unlabelled bytes. */
  readonly type?: string
  /**
   * Offer the body as a download under this name.
   *
   * A filename derived from user data is the ordinary case - an upload's original name, a document
   * title - so this has to survive anything a person can type. Two things follow, and both are tested:
   * a `"` or a newline cannot end the value and write further parameters, and a non-Latin-1 name is
   * encoded rather than thrown on.
   */
  readonly filename?: string
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * Everything a header value may not contain: quotes, backslashes, and the CR/LF that would split the
 * header. Replaced rather than rejected - a filename is cosmetic, and failing a download because a
 * document was titled `Q1 "final"` would be worse than sending it with the quotes dropped.
 */
const UNSAFE_FILENAME = /["\\\r\n]/g

/**
 * Printable ASCII only.
 *
 * A header value is nominally Latin-1, but runtimes do not agree: Bun rejects `é` in a header outright,
 * so "Latin-1 is fine" would have been a portability bug dressed as a standards reading. Printable
 * ASCII is what every runtime and client accepts, and `filename*` carries everything else.
 */
const NON_ASCII = /[^\x20-\x7e]/g

/**
 * `Content-Disposition` for a name that may be anything a user typed.
 *
 * Setting a header containing `报告.pdf` or an emoji THROWS - which on a download route is a 500 for
 * the ordinary act of naming a file in a language ASCII does not cover, and the name usually came from
 * the user in the first place. RFC 6266 exists for exactly this: an ASCII `filename` every client
 * understands, plus `filename*` carrying the real name UTF-8 percent-encoded, which browsers prefer.
 *
 * The ASCII fallback keeps the characters it can rather than substituting a placeholder, so
 * `report 报告.pdf` still arrives as `report .pdf` on a client that ignores `filename*`.
 *
 * `filename*` is built from the SANITIZED name, not the raw one. Percent-encoding would make a hostile
 * name inert either way, but round-tripping `"; attachment; filename="evil.exe` into the header - even
 * encoded - puts an attacker's string somewhere a future reader has to reason about, and the second
 * parameter is only there to carry characters ASCII cannot.
 */
function contentDisposition(filename: string): string {
  const safe = filename.toWellFormed().replace(UNSAFE_FILENAME, "")
  const ascii = safe.replace(NON_ASCII, "")
  const disposition = `attachment; filename="${ascii}"`
  // Only when it adds something: a name ASCII already carries needs no second parameter.
  if (ascii === safe) return disposition
  // encodeURIComponent leaves `'()*` untouched, but RFC 5987's attr-char grammar does not.
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${disposition}; filename*=UTF-8''${encoded}`
}

export function bytes(body: BinaryBody, options: BytesOptions = {}): BinaryResponse {
  const headers = new Headers(options.headers as Record<string, string> | undefined)
  headers.set("content-type", options.type ?? "application/octet-stream")
  headers.set(NIFRA_BINARY_HEADER, "1")
  // Response headers outside the CORS safelist are hidden from cross-origin clients unless exposed.
  // Preserve an existing list and add the marker so the typed contract works cross-origin too.
  const exposed = headers.get("access-control-expose-headers")
  if (exposed !== "*") {
    const names = exposed
      ?.split(",")
      .map((name) => name.trim())
      .filter(Boolean)
    if (!names?.some((name) => name.toLowerCase() === NIFRA_BINARY_HEADER)) {
      headers.set(
        "access-control-expose-headers",
        [...(names ?? []), NIFRA_BINARY_HEADER].join(", "),
      )
    }
  }
  if (options.filename !== undefined) {
    headers.set("content-disposition", contentDisposition(options.filename))
  }
  return new Response(body as ConstructorParameters<typeof Response>[0], {
    status: options.status ?? 200,
    headers,
  }) as BinaryResponse
}
