/** Opt-in rich-wire transport adapter. Kept separate so a bare server never bundles rich values. */
import type { TransportCodec } from "./transport-codec.ts"
import { parse as parseWire, stringify as stringifyWire, type WireDecodeLimits } from "./wire.ts"

export interface RichWireCodecOptions {
  readonly limits?: WireDecodeLimits
}

export function richWireCodec(options: RichWireCodecOptions = {}): TransportCodec {
  const limits = Object.freeze({ ...(options.limits ?? {}) })
  return Object.freeze({
    id: "wire",
    version: 1,
    mediaType: "application/vnd.nifra.wire+json;v=1",
    encode: stringifyWire,
    decode(text: string): unknown {
      return parseWire(text, limits)
    },
  })
}
