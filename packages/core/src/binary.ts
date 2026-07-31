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
   * Quoted and stripped of characters that would end the header value early: a filename derived from
   * user data is the ordinary case (an upload's original name, a document title), and a `"` or a
   * newline in one would otherwise let the caller write their own `Content-Disposition` parameters.
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

export function bytes(body: BinaryBody, options: BytesOptions = {}): BinaryResponse {
  const headers = new Headers(options.headers as Record<string, string> | undefined)
  headers.set("content-type", options.type ?? "application/octet-stream")
  if (options.filename !== undefined) {
    headers.set(
      "content-disposition",
      `attachment; filename="${options.filename.replace(UNSAFE_FILENAME, "")}"`,
    )
  }
  return new Response(body as ConstructorParameters<typeof Response>[0], {
    status: options.status ?? 200,
    headers,
  }) as BinaryResponse
}
