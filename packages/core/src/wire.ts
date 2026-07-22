/**
 * Rich-type wire codec: round-trips values that plain JSON silently drops or corrupts, across any
 * JSON transport (RPC bodies, loader payloads, WebSocket frames).
 *
 * `JSON.stringify` turns `undefined` into a missing key, `Date` into a lossy string, `NaN`/`Infinity`
 * into `null`, loses `-0`, and throws on `BigInt` - and it has no notion of `Map`, `Set`, `RegExp`,
 * `URL`, `ArrayBuffer`, or typed arrays. It also flattens a shared reference into two copies and throws
 * on a cycle. A typed client that infers `Date` from the server type then receives a `string` at runtime
 * is exactly the drift this framework exists to remove. `encode` maps a value to a JSON-safe structure
 * that `decode` reconstructs exactly - including cycles and preserved reference identity; `stringify` /
 * `parse` are the drop-in `JSON.*` equivalents.
 *
 * The wire form is `{ r, n }`: `r` is the root (an inline value or a `ref`), `n` is a flat table of
 * container/rich nodes addressed by index. Because every object is interned in `n` and referenced by
 * index, a shared object is encoded once (and decodes to a single shared instance), and a cycle is a
 * back-reference rather than infinite recursion. Functions and symbols are rejected, never silently
 * dropped. Decoding validates every tag and index, so a malformed payload throws {@link WireDecodeError}
 * rather than producing a corrupt value.
 *
 * Not covered by design (matches `JSON`): class identity (a class instance decodes to a plain object
 * carrying its own enumerable properties), non-enumerable and symbol keys, and getters (read once).
 */

/** Discriminator key on a tagged wire node. Never collides with user data: user objects live under a
 * node's `v` field, so their own keys - including one literally named `$w` - are never re-interpreted. */
const TAG = "$w"

/** The JSON-safe encoded form produced by {@link encode} and consumed by {@link decode}. */
export interface Wire {
  /** The root value: an inline primitive/scalar, or a `{ [TAG]: "ref", i }` into {@link Wire.n}. */
  readonly r: unknown
  /** Interned container and rich-type nodes, addressed by index from `ref`s. */
  readonly n: readonly unknown[]
}

/** Resource limits applied while reconstructing transport-controlled wire data. */
export interface WireDecodeLimits {
  /** Maximum number of interned nodes. Default 10,000. */
  readonly maxNodes?: number
  /** Maximum nesting depth across containers and references. Default 256. */
  readonly maxDepth?: number
  /** Maximum total object/array/map/set entries visited. Default 100,000. */
  readonly maxCollectionEntries?: number
  /** Maximum UTF-8 string plus decoded binary bytes materialized. Default 16 MiB. */
  readonly maxDecodedBytes?: number
}

export const DEFAULT_WIRE_DECODE_LIMITS: Readonly<Required<WireDecodeLimits>> = Object.freeze({
  maxNodes: 10_000,
  maxDepth: 256,
  maxCollectionEntries: 100_000,
  maxDecodedBytes: 16 * 1024 * 1024,
})

/** Thrown by {@link encode} for a value it will not encode (a function or a symbol). */
export class WireEncodeError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = "WireEncodeError"
  }
}

/** Thrown by {@link decode} for a wire value carrying an unknown tag, a bad index, or malformed shape. */
export class WireDecodeError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = "WireDecodeError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function decodeLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`wire decode ${label} must be a non-negative safe integer`)
  }
  return limit
}

function utf8ByteLength(value: string, stopAfter = Number.MAX_SAFE_INTEGER): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes++
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 3
    } else bytes += 3
    if (bytes > stopAfter) return bytes
  }
  return bytes
}

/** The typed-array kinds the codec round-trips, by constructor name. */
const TYPED_ARRAYS = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
} as const
type TypedArrayName = keyof typeof TYPED_ARRAYS
type TypedArray = InstanceType<(typeof TYPED_ARRAYS)[TypedArrayName]>

function defineEnumerableOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

// ─── encode ─────────────────────────────────────────────────────────────────

/** Encode any supported value into a JSON-safe {@link Wire} form. */
export function encode(value: unknown): Wire {
  const nodes: unknown[] = []
  const interned = new Map<object, number>()

  /** Encode a value to its inline wire form, interning objects into `nodes` and returning a `ref`. */
  const inline = (v: unknown): unknown => {
    if (v === undefined) return { [TAG]: "undef" }
    if (v === null) return null

    switch (typeof v) {
      case "string":
      case "boolean":
        return v
      case "number":
        if (Object.is(v, -0)) return { [TAG]: "num", v: "-0" }
        if (Number.isNaN(v)) return { [TAG]: "num", v: "NaN" }
        if (v === Infinity) return { [TAG]: "num", v: "Infinity" }
        if (v === -Infinity) return { [TAG]: "num", v: "-Infinity" }
        return v // a finite, signed-zero-free number is already JSON-safe
      case "bigint":
        return { [TAG]: "bigint", v: v.toString() }
      case "function":
      case "symbol":
        throw new WireEncodeError(`cannot encode a ${typeof v}`)
    }

    const obj = v as object
    const existing = interned.get(obj)
    if (existing !== undefined) return { [TAG]: "ref", i: existing }

    // Reserve this object's index BEFORE encoding its body, so a self- or mutual-reference inside the
    // body resolves to a `ref` here instead of recursing forever.
    const index = nodes.length
    interned.set(obj, index)
    nodes.push(0) // placeholder, overwritten below
    nodes[index] = body(v, inline)
    return { [TAG]: "ref", i: index }
  }

  return { r: inline(value), n: nodes }
}

/** Encode the interned body of one object into its tagged node. */
function body(v: unknown, inline: (x: unknown) => unknown): unknown {
  if (v instanceof Date) {
    const time = v.getTime()
    return { [TAG]: "date", v: Number.isNaN(time) ? null : v.toISOString() }
  }
  if (v instanceof RegExp) return { [TAG]: "regexp", v: [v.source, v.flags] }
  if (v instanceof URL) return { [TAG]: "url", v: v.href }
  if (v instanceof ArrayBuffer) return { [TAG]: "buf", v: bytesToBase64(new Uint8Array(v)) }
  if (v instanceof DataView) {
    return { [TAG]: "dv", v: bytesToBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) }
  }
  if (ArrayBuffer.isView(v)) {
    const view = v as TypedArray
    const kind = view.constructor.name
    if (!(kind in TYPED_ARRAYS)) throw new WireEncodeError(`cannot encode typed array ${kind}`)
    return {
      [TAG]: "ta",
      k: kind,
      v: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
    }
  }
  if (v instanceof Map) {
    return { [TAG]: "map", v: Array.from(v, ([k, val]) => [inline(k), inline(val)]) }
  }
  if (v instanceof Set) return { [TAG]: "set", v: Array.from(v, (item) => inline(item)) }
  if (Array.isArray(v)) return { [TAG]: "arr", v: v.map((item) => inline(item)) }

  const record = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) defineEnumerableOwn(out, key, inline(record[key]))
  return { [TAG]: "obj", v: out }
}

// ─── decode ─────────────────────────────────────────────────────────────────

/** Reconstruct the original value from a {@link Wire} form produced by {@link encode}. */
export function decode(wire: Wire, limits: WireDecodeLimits = {}): unknown {
  if (!isRecord(wire) || !Object.hasOwn(wire, "r") || !Array.isArray(wire.n)) {
    throw new WireDecodeError("not a wire value: expected { r, n }")
  }
  const nodes = wire.n
  const maxNodes = decodeLimit(limits.maxNodes, DEFAULT_WIRE_DECODE_LIMITS.maxNodes, "maxNodes")
  const maxDepth = decodeLimit(limits.maxDepth, DEFAULT_WIRE_DECODE_LIMITS.maxDepth, "maxDepth")
  const maxCollectionEntries = decodeLimit(
    limits.maxCollectionEntries,
    DEFAULT_WIRE_DECODE_LIMITS.maxCollectionEntries,
    "maxCollectionEntries",
  )
  const maxDecodedBytes = decodeLimit(
    limits.maxDecodedBytes,
    DEFAULT_WIRE_DECODE_LIMITS.maxDecodedBytes,
    "maxDecodedBytes",
  )
  if (nodes.length > maxNodes) throw new WireDecodeError("wire node limit exceeded")
  const built = new Map<number, unknown>()
  let collectionEntries = 0
  let decodedBytes = 0

  const enter = (depth: number): void => {
    if (depth > maxDepth) throw new WireDecodeError("wire depth limit exceeded")
  }
  const chargeEntries = (count: number): void => {
    collectionEntries += count
    if (!Number.isSafeInteger(collectionEntries) || collectionEntries > maxCollectionEntries) {
      throw new WireDecodeError("wire collection entry limit exceeded")
    }
  }
  const chargeBytes = (count: number): void => {
    decodedBytes += count
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > maxDecodedBytes) {
      throw new WireDecodeError("wire decoded byte limit exceeded")
    }
  }
  const chargeString = (value: string): void =>
    chargeBytes(utf8ByteLength(value, maxDecodedBytes - decodedBytes))

  const inline = (w: unknown, depth: number): unknown => {
    enter(depth)
    if (w === null || typeof w === "boolean") return w
    if (typeof w === "string") {
      chargeString(w)
      return w
    }
    if (typeof w === "number") {
      if (!Number.isFinite(w) || Object.is(w, -0)) {
        throw new WireDecodeError("malformed wire: non-JSON number inline")
      }
      return w
    }
    if (!isRecord(w)) throw new WireDecodeError("malformed wire: invalid inline value")
    const record = w
    const tag = record[TAG]
    if (typeof tag !== "string")
      throw new WireDecodeError("malformed wire: object without a tag inline")
    switch (tag) {
      case "undef":
        return undefined
      case "num": {
        const v = record.v
        if (v === "-0") return -0
        if (v === "NaN") return NaN
        if (v === "Infinity") return Infinity
        if (v === "-Infinity") return -Infinity
        throw new WireDecodeError(`malformed num token: ${String(v)}`)
      }
      case "bigint": {
        if (typeof record.v !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(record.v)) {
          throw new WireDecodeError("malformed bigint token")
        }
        chargeString(record.v)
        return BigInt(record.v)
      }
      case "ref":
        return resolve(record.i, depth)
      default:
        throw new WireDecodeError(`unexpected inline tag: ${tag}`)
    }
  }

  const resolve = (raw: unknown, depth: number): unknown => {
    enter(depth)
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw >= nodes.length) {
      throw new WireDecodeError(`ref out of range: ${String(raw)}`)
    }
    const index = raw
    const cached = built.get(index)
    if (cached !== undefined || built.has(index)) return cached

    const node = nodes[index]
    if (!isRecord(node)) throw new WireDecodeError(`malformed node at ${index}`)
    const record = node
    const tag = record[TAG]

    switch (tag) {
      case "obj": {
        if (!isRecord(record.v)) throw new WireDecodeError(`malformed obj node at ${index}`)
        const out: Record<string, unknown> = {}
        built.set(index, out) // publish the shell first so cycles resolve to it
        const src = record.v
        const keys = Object.keys(src)
        chargeEntries(keys.length)
        for (const key of keys) {
          chargeString(key)
          defineEnumerableOwn(out, key, inline(src[key], depth + 1))
        }
        return out
      }
      case "arr": {
        if (!Array.isArray(record.v)) throw new WireDecodeError(`malformed arr node at ${index}`)
        const out: unknown[] = []
        built.set(index, out)
        chargeEntries(record.v.length)
        for (const item of record.v) out.push(inline(item, depth + 1))
        return out
      }
      case "map": {
        if (!Array.isArray(record.v)) throw new WireDecodeError(`malformed map node at ${index}`)
        const out = new Map<unknown, unknown>()
        built.set(index, out)
        chargeEntries(record.v.length)
        for (const entry of record.v) {
          if (!Array.isArray(entry) || entry.length !== 2) {
            throw new WireDecodeError(`malformed map entry at ${index}`)
          }
          out.set(inline(entry[0], depth + 1), inline(entry[1], depth + 1))
        }
        return out
      }
      case "set": {
        if (!Array.isArray(record.v)) throw new WireDecodeError(`malformed set node at ${index}`)
        const out = new Set<unknown>()
        built.set(index, out)
        chargeEntries(record.v.length)
        for (const item of record.v) out.add(inline(item, depth + 1))
        return out
      }
      case "date": {
        if (record.v !== null && typeof record.v !== "string") {
          throw new WireDecodeError(`malformed date node at ${index}`)
        }
        if (record.v !== null) chargeString(record.v)
        const out = record.v === null ? new Date(NaN) : new Date(record.v)
        if (record.v !== null && (Number.isNaN(out.getTime()) || out.toISOString() !== record.v)) {
          throw new WireDecodeError(`malformed date node at ${index}`)
        }
        built.set(index, out)
        return out
      }
      case "regexp": {
        if (
          !Array.isArray(record.v) ||
          record.v.length !== 2 ||
          typeof record.v[0] !== "string" ||
          typeof record.v[1] !== "string"
        ) {
          throw new WireDecodeError(`malformed regexp node at ${index}`)
        }
        chargeString(record.v[0])
        chargeString(record.v[1])
        let out: RegExp
        try {
          out = new RegExp(record.v[0], record.v[1])
        } catch {
          throw new WireDecodeError(`malformed regexp node at ${index}`)
        }
        built.set(index, out)
        return out
      }
      case "url": {
        if (typeof record.v !== "string") {
          throw new WireDecodeError(`malformed url node at ${index}`)
        }
        chargeString(record.v)
        let out: URL
        try {
          out = new URL(record.v)
        } catch {
          throw new WireDecodeError(`malformed url node at ${index}`)
        }
        built.set(index, out)
        return out
      }
      case "buf": {
        const out = base64ToBytes(record.v, index, chargeBytes).buffer
        built.set(index, out)
        return out
      }
      case "dv": {
        const out = new DataView(base64ToBytes(record.v, index, chargeBytes).buffer)
        built.set(index, out)
        return out
      }
      case "ta": {
        const kind = record.k
        if (typeof kind !== "string" || !(kind in TYPED_ARRAYS)) {
          throw new WireDecodeError(`unknown typed array: ${String(kind)}`)
        }
        const Ctor = TYPED_ARRAYS[kind as TypedArrayName]
        const bytes = base64ToBytes(record.v, index, chargeBytes)
        if (bytes.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) {
          throw new WireDecodeError(`misaligned bytes for ${kind}`)
        }
        // `base64ToBytes` always allocates a fresh, non-shared ArrayBuffer, so this narrowing is sound.
        const out = new Ctor(
          bytes.buffer as ArrayBuffer,
          0,
          bytes.byteLength / Ctor.BYTES_PER_ELEMENT,
        )
        built.set(index, out)
        return out
      }
      default:
        throw new WireDecodeError(`unknown wire tag: ${String(tag)}`)
    }
  }

  return inline(wire.r, 0)
}

/** `encode` + `JSON.stringify` in one call - the rich-type equivalent of `JSON.stringify`. */
export function stringify(value: unknown): string {
  return JSON.stringify(encode(value))
}

/** `JSON.parse` + `decode` in one call - the rich-type equivalent of `JSON.parse`. */
export function parse(text: string, limits: WireDecodeLimits = {}): unknown {
  return decode(JSON.parse(text) as Wire, limits)
}

// ─── base64 (portable across Bun / browser / Workers / Node / Deno) ───────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const CHUNK = 0x8000 // chunk so String.fromCharCode(...) never overflows the call stack
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

function base64ToBytes(
  base64: unknown,
  index: number,
  reserve: (decodedBytes: number) => void,
): Uint8Array {
  if (typeof base64 !== "string" || base64.length % 4 !== 0) {
    throw new WireDecodeError(`malformed base64 at ${index}`)
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  reserve((base64.length / 4) * 3 - padding)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) {
    throw new WireDecodeError(`malformed base64 at ${index}`)
  }
  let binary: string
  try {
    binary = atob(base64)
  } catch {
    throw new WireDecodeError(`malformed base64 at ${index}`)
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
