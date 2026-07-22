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
    return { [TAG]: "ta", k: kind, v: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) }
  }
  if (v instanceof Map) {
    return { [TAG]: "map", v: Array.from(v, ([k, val]) => [inline(k), inline(val)]) }
  }
  if (v instanceof Set) return { [TAG]: "set", v: Array.from(v, (item) => inline(item)) }
  if (Array.isArray(v)) return { [TAG]: "arr", v: v.map((item) => inline(item)) }

  const record = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) out[key] = inline(record[key])
  return { [TAG]: "obj", v: out }
}

// ─── decode ─────────────────────────────────────────────────────────────────

/** Reconstruct the original value from a {@link Wire} form produced by {@link encode}. */
export function decode(wire: Wire): unknown {
  if (wire === null || typeof wire !== "object" || !Array.isArray((wire as Wire).n)) {
    throw new WireDecodeError("not a wire value: expected { r, n }")
  }
  const nodes = (wire as Wire).n
  const built = new Map<number, unknown>()

  const inline = (w: unknown): unknown => {
    if (w === null || typeof w !== "object") return w // JSON primitive stands for itself
    const record = w as Record<string, unknown>
    const tag = record[TAG]
    if (typeof tag !== "string") throw new WireDecodeError("malformed wire: object without a tag inline")
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
      case "bigint":
        return BigInt(record.v as string)
      case "ref":
        return resolve(record.i)
      default:
        throw new WireDecodeError(`unexpected inline tag: ${tag}`)
    }
  }

  const resolve = (raw: unknown): unknown => {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw >= nodes.length) {
      throw new WireDecodeError(`ref out of range: ${String(raw)}`)
    }
    const index = raw
    const cached = built.get(index)
    if (cached !== undefined || built.has(index)) return cached

    const node = nodes[index]
    if (node === null || typeof node !== "object") throw new WireDecodeError(`malformed node at ${index}`)
    const record = node as Record<string, unknown>
    const tag = record[TAG]

    switch (tag) {
      case "obj": {
        const out: Record<string, unknown> = {}
        built.set(index, out) // publish the shell first so cycles resolve to it
        const src = record.v as Record<string, unknown>
        for (const key of Object.keys(src)) out[key] = inline(src[key])
        return out
      }
      case "arr": {
        const out: unknown[] = []
        built.set(index, out)
        for (const item of record.v as unknown[]) out.push(inline(item))
        return out
      }
      case "map": {
        const out = new Map<unknown, unknown>()
        built.set(index, out)
        for (const [k, val] of record.v as Array<[unknown, unknown]>) out.set(inline(k), inline(val))
        return out
      }
      case "set": {
        const out = new Set<unknown>()
        built.set(index, out)
        for (const item of record.v as unknown[]) out.add(inline(item))
        return out
      }
      case "date": {
        const out = record.v === null ? new Date(NaN) : new Date(record.v as string)
        built.set(index, out)
        return out
      }
      case "regexp": {
        const [source, flags] = record.v as [string, string]
        const out = new RegExp(source, flags)
        built.set(index, out)
        return out
      }
      case "url": {
        const out = new URL(record.v as string)
        built.set(index, out)
        return out
      }
      case "buf": {
        const out = base64ToBytes(record.v as string).buffer
        built.set(index, out)
        return out
      }
      case "dv": {
        const out = new DataView(base64ToBytes(record.v as string).buffer)
        built.set(index, out)
        return out
      }
      case "ta": {
        const kind = record.k as string
        if (!(kind in TYPED_ARRAYS)) throw new WireDecodeError(`unknown typed array: ${kind}`)
        const Ctor = TYPED_ARRAYS[kind as TypedArrayName]
        const bytes = base64ToBytes(record.v as string)
        if (bytes.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) {
          throw new WireDecodeError(`misaligned bytes for ${kind}`)
        }
        // `base64ToBytes` always allocates a fresh, non-shared ArrayBuffer, so this narrowing is sound.
        const out = new Ctor(bytes.buffer as ArrayBuffer, 0, bytes.byteLength / Ctor.BYTES_PER_ELEMENT)
        built.set(index, out)
        return out
      }
      default:
        throw new WireDecodeError(`unknown wire tag: ${String(tag)}`)
    }
  }

  return inline((wire as Wire).r)
}

/** `encode` + `JSON.stringify` in one call - the rich-type equivalent of `JSON.stringify`. */
export function stringify(value: unknown): string {
  return JSON.stringify(encode(value))
}

/** `JSON.parse` + `decode` in one call - the rich-type equivalent of `JSON.parse`. */
export function parse(text: string): unknown {
  return decode(JSON.parse(text) as Wire)
}

// ─── base64 (portable across Bun / browser / Workers / Node / Deno) ───────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const CHUNK = 0x8000 // chunk so String.fromCharCode(...) never overflows the call stack
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
