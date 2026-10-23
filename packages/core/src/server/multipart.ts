/**
 * Typed `multipart/form-data` request bodies - `multipartBody(schema, limits?)`.
 *
 * A route reads JSON and urlencoded bodies by default and answers `415` to everything else. Wrapping
 * its body schema opts that one route into multipart: the parts are read under the route's
 * `bodyLimit`, bounded by count and size, collected into one record, and handed to the schema.
 * The body is parsed here, by the Fetch standard's `multipart/form-data` parser, and not by the
 * runtime's own `formData()`: those disagree on bare line feeds, parts with no name, escaped or
 * percent-encoded names, and a file's default type, so one body was a different form on each runtime.
 *
 *   import { multipartBody } from "@nifrajs/core/multipart"
 *   import { t } from "@nifrajs/schema"
 *
 *   app.post(
 *     "/avatars",
 *     {
 *       body: multipartBody(
 *         t.form({ avatar: t.file({ maxBytes: 2_000_000, accept: ["image/png"] }), alt: t.string() }),
 *       ),
 *       bodyLimit: 2_500_000,
 *     },
 *     (c) => store(c.body.avatar),
 *   )
 *
 * The schema sees a null-prototype record: a text part is a string, a file part is a `File`, and a
 * name that repeats becomes an array in part order. A file part with no bytes is left out: that is
 * what an empty file input submits, so an optional file field validates as absent.
 *
 * What the reader guarantees before the schema runs:
 * - the body is at most `bodyLimit` bytes, measured on the bytes delivered and not on the header
 * - at most `maxFields + maxFiles` parts, counted on the raw bytes before anything is parsed
 * - one boundary, taken from the header by one strict grammar and handed to the parser as-is
 * - every text value is at most `maxFieldBytes` and every file at most `maxFileBytes`
 * - a file name is a bare name: no directory, no control or bidirectional-override characters
 * - a `__proto__` part follows the app's prototype-poisoning policy
 *
 * What it does not: a file's `name` and `type` are still the client's claim. Check content with a
 * schema that reads the bytes, and store uploads under a key you generate.
 *
 * The whole body is buffered, so a request costs about twice its size in memory while it is parsed.
 * Send large uploads straight to storage with a presigned URL instead of raising `bodyLimit`.
 */
import type { StandardSchemaV1 } from "../schema/standard.ts"
import { assertByteLimit, readBoundedBytes, UNLIMITED_BODY_BYTES } from "./body.ts"
import { SCHEMA_BODY_READER, type SchemaBodyReader } from "./body-lane.ts"
import { plainError } from "./http.ts"
import type { ResponseResult } from "./runtime-core.ts"

/** Per-route bounds on a multipart body. The total size is the route's `bodyLimit`. */
export interface MultipartLimits {
  /** Most text parts a request may carry. Default `100`. */
  readonly maxFields?: number
  /** Most file parts a request may carry. Empty files are not counted. Default `10`. */
  readonly maxFiles?: number
  /** Largest text value, in UTF-8 bytes. Default `65536`. */
  readonly maxFieldBytes?: number
  /** Largest single file, in bytes. Defaults to no bound beyond the route's `bodyLimit`. */
  readonly maxFileBytes?: number
}

/** A value of the record handed to the schema: one part, or every part that shared the name. */
export type MultipartValue = string | File | Array<string | File>

const DEFAULT_MAX_FIELDS = 100
const DEFAULT_MAX_FILES = 10
const DEFAULT_MAX_FIELD_BYTES = 65_536

const MEDIA_TYPE = "multipart/form-data"
// RFC 2046 `bchars` without the space: what a boundary may be made of.
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=?]{1,70}$/
// RFC 9110 `token`: a parameter name, and a value that needs no quoting.
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const FALLBACK_FILE_NAME = "file"
const MAX_FILE_NAME_LENGTH = 255

const DASH = 45
const CR = 13
const LF = 10
const COLON = 58
const PERCENT = 37
const QUOTE = 34
const BACKSLASH = 92
const SLASH = 47
const SEMICOLON = 59
const SPACE = 32
const TAB = 9

const INVALID = (): ResponseResult => plainError(400, "invalid_multipart")

const ASCII = new TextEncoder()
// The Fetch standard reads a disposition only in this exact form, which every browser writes.
const FORM_DATA_NAME = ASCII.encode('form-data; name="')
const FILE_NAME = ASCII.encode('; filename="')
const CONTENT_DISPOSITION = ASCII.encode("content-disposition")
const CONTENT_TYPE = ASCII.encode("content-type")
// "UTF-8 decode without BOM": a leading BOM is kept as U+FEFF, not dropped.
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true })
// A short ASCII name or value is read code by code: a decoder call costs more than the bytes.
const SHORT_TEXT = 64

// RFC 9110 `tchar`, by byte value.
const TCHAR = new Uint8Array(128)
for (const char of "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz") {
  TCHAR[char.charCodeAt(0)] = 1
}

function limitOf(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  assertByteLimit(value, `multipartBody: ${name}`)
  return value
}

/**
 * The boundary of a `multipart/form-data` content type. `undefined` when the media type is another
 * one, `null` when it is multipart but its parameters are malformed, repeat `boundary`, or carry a
 * boundary outside the RFC 2046 alphabet.
 */
function boundaryOf(contentType: string): string | null | undefined {
  const semi = contentType.indexOf(";")
  const essence = (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase()
  if (essence !== MEDIA_TYPE) return undefined
  if (semi === -1) return null

  const end = contentType.length
  let boundary: string | undefined
  let i = semi
  while (i < end) {
    i++ // past the `;`
    while (i < end && isBlank(contentType.charCodeAt(i))) i++
    if (i >= end) break
    const eq = contentType.indexOf("=", i)
    if (eq === -1) return null
    const name = contentType.slice(i, eq)
    if (!TOKEN.test(name)) return null
    i = eq + 1
    let value: string
    if (contentType.charCodeAt(i) === QUOTE) {
      let close = i + 1
      while (close < end && contentType.charCodeAt(close) !== QUOTE) {
        close += contentType.charCodeAt(close) === BACKSLASH ? 2 : 1
      }
      if (close >= end) return null
      // Kept raw: an escaped character is outside the boundary alphabet, so it fails the test below.
      value = contentType.slice(i + 1, close)
      i = close + 1
      while (i < end && isBlank(contentType.charCodeAt(i))) i++
      if (i < end && contentType.charCodeAt(i) !== SEMICOLON) return null
    } else {
      const next = contentType.indexOf(";", i)
      const stop = next === -1 ? end : next
      value = contentType.slice(i, stop).trimEnd()
      i = stop
    }
    if (name.toLowerCase() !== "boundary") continue
    if (boundary !== undefined || !BOUNDARY.test(value)) return null
    boundary = value
  }
  return boundary ?? null
}

function isBlank(code: number): boolean {
  return code === SPACE || code === TAB
}

function failureTable(pattern: Uint8Array): Uint8Array {
  const table = new Uint8Array(pattern.length)
  for (let i = 1, k = 0; i < pattern.length; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = table[k - 1]!
    if (pattern[i] === pattern[k]) k++
    table[i] = k
  }
  return table
}

/** What a scan for `--boundary` found: where each one starts, and how many close an empty part. */
interface Delimiters {
  readonly at: readonly number[]
  readonly empty: number
}

/** The most delimiters a scan counts: past either budget the body is refused unparsed. */
interface DelimiterLimits {
  readonly filled: number
  readonly empty: number
}

/**
 * Whether the delimiter at `at` closes a part with no content: the blank line ending the part's
 * headers is followed at once by the CRLF that opens the delimiter. A part whose own content ends
 * in a blank line reads the same, which only spends the empty budget instead of the filled one.
 */
function closesEmptyPart(bytes: Uint8Array, at: number): boolean {
  return (
    at >= 6 &&
    bytes[at - 1] === LF &&
    bytes[at - 2] === CR &&
    bytes[at - 3] === LF &&
    bytes[at - 4] === CR &&
    bytes[at - 5] === LF &&
    bytes[at - 6] === CR
  )
}

const overLimits = (count: number, empty: number, limits: DelimiterLimits): boolean =>
  count - empty > limits.filled || empty > limits.empty

/** Knuth-Morris-Pratt from `start`: linear in the input whatever the pattern repeats. */
function scanFrom(
  bytes: Uint8Array,
  pattern: Uint8Array,
  start: number,
  at: number[],
  countedEmpty: number,
  limits: DelimiterLimits,
): Delimiters {
  const table = failureTable(pattern)
  const size = pattern.length
  let empty = countedEmpty
  for (let i = start, k = 0; i < bytes.length; i++) {
    const byte = bytes[i]
    while (k > 0 && byte !== pattern[k]) k = table[k - 1]!
    if (byte === pattern[k]) k++
    if (k === size) {
      if (at.length > 0 && closesEmptyPart(bytes, i + 1 - size)) empty++
      at.push(i + 1 - size)
      if (overLimits(at.length, empty, limits)) break
      k = 0
    }
  }
  return { at, empty }
}

declare const Deno: unknown

// V8's TypedArray `indexOf` reads one element at a time (~0.6 ms a MiB on Node 26), where Buffer's is
// native on Node and Bun. Deno's Buffer is a slower polyfill, and Workers have none by default.
const bufferIndexOf =
  typeof Deno === "undefined" && typeof Buffer === "function" ? Buffer.prototype.indexOf : undefined

/**
 * Find the non-overlapping occurrences of `pattern` (which starts with a dash), stopping once the
 * count passes `limit`. Every `--boundary` is counted wherever it sits, which is at least what any
 * parser can treat as a delimiter.
 *
 * The native search for the next dash skips binary content at memory speed. A body built to make
 * the verify loop re-read the same bytes (dashes against a boundary of dashes) spends a budget of
 * one pass over the input, then the scan continues with the linear matcher.
 */
function scanDelimiters(
  bytes: Uint8Array,
  pattern: Uint8Array,
  limits: DelimiterLimits,
): Delimiters {
  const size = pattern.length
  const last = bytes.length - size
  const at: number[] = []
  let empty = 0
  let work = 0
  let i = 0
  while (i <= last) {
    i = bufferIndexOf === undefined ? bytes.indexOf(DASH, i) : bufferIndexOf.call(bytes, DASH, i)
    if (i === -1 || i > last) break
    let k = 1
    while (k < size && bytes[i + k] === pattern[k]) k++
    if (k === size) {
      if (at.length > 0 && closesEmptyPart(bytes, i)) empty++
      at.push(i)
      i += size
      if (overLimits(at.length, empty, limits)) break
      continue
    }
    work += k
    if (work > bytes.length) return scanFrom(bytes, pattern, i, at, empty, limits)
    i++
  }
  return { at, empty }
}

// What the File constructor keeps of a type: printable ASCII, lower-cased; anything else is "".
const PRINTABLE = /^[\x20-\x7e]*$/

/**
 * `content` as a File whose type is what the standard makes of `type`. Bun's constructor appends
 * `;charset=utf-8` to an exact lower-case `text/plain`, `text/html` or `application/json`, but not
 * to the same type in upper case, which it lower-cases like every runtime.
 */
function fileOf(content: Uint8Array<ArrayBuffer>, name: string, type: string): File {
  const wanted = PRINTABLE.test(type) ? type.toLowerCase() : ""
  const file = new File([content], name, { type: wanted })
  return file.type === wanted ? file : new File([content], name, { type: wanted.toUpperCase() })
}

/** One part as the parser read it: its field, its file name if it is a file, and its content. */
interface Part {
  readonly name: string
  readonly filename: string | null
  readonly type: string | null
  readonly start: number
  readonly end: number
}

/** The first index from `from` holding byte `a`, `b` or `c`, or the end of `bytes`. */
function scanUntil(bytes: Uint8Array, from: number, a: number, b: number, c: number): number {
  let i = from
  while (i < bytes.length) {
    const byte = bytes[i]
    if (byte === a || byte === b || byte === c) break
    i++
  }
  return i
}

function startsWith(bytes: Uint8Array, at: number, prefix: Uint8Array): boolean {
  if (at + prefix.length > bytes.length) return false
  for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix[i]) return false
  return true
}

/** `bytes[start, end)` as UTF-8 text. */
function textOf(bytes: Uint8Array, start: number, end: number): string {
  if (end - start <= SHORT_TEXT) {
    let out = ""
    for (let i = start; i < end; i++) {
      const byte = bytes[i]!
      if (byte >= 0x80) return UTF8.decode(bytes.subarray(start, end))
      out += String.fromCharCode(byte)
    }
    return out
  }
  return UTF8.decode(bytes.subarray(start, end))
}

/** Whether `bytes[start, end)` spells `lower`, a lower-case ASCII header name, in any case. */
function spells(bytes: Uint8Array, start: number, end: number, lower: Uint8Array): boolean {
  if (end - start !== lower.length) return false
  // A CR also folds onto `-`, but no header name holds one.
  for (let i = 0; i < lower.length; i++) if ((bytes[start + i]! | 0x20) !== lower[i]) return false
  return true
}

/** Bytes as the code points of the same values ("isomorphic decode"), for a header's value. */
function isomorphic(bytes: Uint8Array, start: number, end: number): string {
  let out = ""
  for (let i = start; i < end; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + 4096)))
  }
  return out
}

/**
 * A quoted `name` or `filename` from the byte after its opening quote: everything up to the closing
 * one, with `%0A`, `%0D` and `%22` restored. No backslash escapes, as the standard reads it.
 */
function quotedName(bytes: Uint8Array, from: number): { value: string; next: number } | undefined {
  const close = scanUntil(bytes, from, LF, CR, QUOTE)
  if (bytes[close] !== QUOTE) return undefined
  let value = textOf(bytes, from, close)
  if (bytes.subarray(from, close).includes(PERCENT)) {
    value = value.replaceAll("%0A", "\n").replaceAll("%0D", "\r").replaceAll("%22", '"')
  }
  return { value, next: close + 1 }
}

/**
 * The headers of the part whose first header line starts at `from`, up to the blank line that
 * ends them. Undefined when a line does not parse or the part names no field.
 */
function partHeaders(
  bytes: Uint8Array,
  from: number,
): { name: string; filename: string | null; type: string | null; next: number } | undefined {
  let position = from
  let name: string | null = null
  let filename: string | null = null
  let type: string | null = null
  for (;;) {
    if (bytes[position] === CR && bytes[position + 1] === LF) {
      return name === null ? undefined : { name, filename, type, next: position + 2 }
    }
    const colon = scanUntil(bytes, position, LF, CR, COLON)
    if (bytes[colon] !== COLON) return undefined
    let start = position
    let end = colon
    while (start < end && isBlank(bytes[start]!)) start++
    while (end > start && isBlank(bytes[end - 1]!)) end--
    if (start === end) return undefined
    for (let i = start; i < end; i++) if (TCHAR[bytes[i]!] !== 1) return undefined
    position = colon + 1
    while (isBlank(bytes[position] ?? 0)) position++
    if (spells(bytes, start, end, CONTENT_DISPOSITION)) {
      name = null
      filename = null
      if (!startsWith(bytes, position, FORM_DATA_NAME)) return undefined
      const parsed = quotedName(bytes, position + FORM_DATA_NAME.length)
      if (parsed === undefined) return undefined
      name = parsed.value
      position = parsed.next
      if (startsWith(bytes, position, FILE_NAME)) {
        const file = quotedName(bytes, position + FILE_NAME.length)
        if (file === undefined) return undefined
        filename = file.value
        position = file.next
      }
    } else {
      const stop = scanUntil(bytes, position, LF, CR, LF)
      if (spells(bytes, start, end, CONTENT_TYPE)) {
        let end = stop
        while (end > position && isBlank(bytes[end - 1]!)) end--
        type = isomorphic(bytes, position, end)
      }
      position = stop
    }
    if (bytes[position] !== CR || bytes[position + 1] !== LF) return undefined
    position += 2
  }
}

/**
 * The parts of a body, read as the Fetch standard's `multipart/form-data` parser reads them: the
 * body opens with `--boundary`, every part's content runs to the next CRLF `--boundary`, and the
 * first `--boundary--` closes it. `at` holds every `--boundary` in the body; those that do not start
 * a line are content. Undefined when the body is not such a form.
 */
function partsOf(bytes: Uint8Array, at: readonly number[], size: number): Part[] | undefined {
  if (at[0] !== 0) return undefined
  const parts: Part[] = []
  let position = 0
  let next = 0
  for (;;) {
    position += size
    if (bytes[position] === DASH && bytes[position + 1] === DASH) return parts
    if (bytes[position] !== CR || bytes[position + 1] !== LF) return undefined
    const head = partHeaders(bytes, position + 2)
    if (head === undefined) return undefined
    position = head.next
    let end: number
    do end = at[++next] ?? -1
    while (end !== -1 && (end - 2 < position || bytes[end - 2] !== CR || bytes[end - 1] !== LF))
    if (end === -1) return undefined
    parts.push({
      name: head.name,
      filename: head.filename,
      type: head.type,
      start: position,
      end: end - 2,
    })
    position = end
  }
}

/** C0 controls, DEL, line separators, and the characters that reorder or hide text in a label. */
function isUnsafeNameCode(code: number): boolean {
  return (
    code < 0x20 ||
    code === 0x7f ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

/**
 * A client file name reduced to a bare name: the text after the last `/` or `\`, without control
 * and bidirectional characters, at most 255 code units. A name with nothing left is `"file"`.
 */
function safeFileName(raw: string): string {
  let start = 0
  let dirty = false
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code === SLASH || code === BACKSLASH) {
      start = i + 1
      dirty = false
    } else if (isUnsafeNameCode(code)) dirty = true
  }
  let name = raw
  if (dirty) {
    name = ""
    for (let i = start; i < raw.length; i++) {
      if (!isUnsafeNameCode(raw.charCodeAt(i))) name += raw[i]
    }
  } else if (start > 0) name = raw.slice(start)
  name = name.trim()
  if (name.length > MAX_FILE_NAME_LENGTH) {
    const lastKept = name.charCodeAt(MAX_FILE_NAME_LENGTH - 1)
    // Never end on the first half of a surrogate pair.
    const cut = lastKept >= 0xd800 && lastKept <= 0xdbff ? 1 : 0
    name = name.slice(0, MAX_FILE_NAME_LENGTH - cut).trimEnd()
  }
  return name === "" || name === "." || name === ".." ? FALLBACK_FILE_NAME : name
}

function createReader(
  limits: MultipartLimits,
  inner: SchemaBodyReader | undefined,
): SchemaBodyReader {
  const maxFields = limitOf(limits.maxFields, DEFAULT_MAX_FIELDS, "maxFields")
  const maxFiles = limitOf(limits.maxFiles, DEFAULT_MAX_FILES, "maxFiles")
  const maxFieldBytes = limitOf(limits.maxFieldBytes, DEFAULT_MAX_FIELD_BYTES, "maxFieldBytes")
  const maxFileBytes = limitOf(limits.maxFileBytes, UNLIMITED_BODY_BYTES, "maxFileBytes")
  // Every part sits between two delimiters, and the last delimiter closes the body. A part with no
  // content - a file input left empty, which is dropped below - spends a budget of its own, so an
  // untouched optional input does not count against the parts that carry something.
  const delimiterLimits: DelimiterLimits = {
    filled: maxFields + maxFiles + 1,
    empty: maxFields + maxFiles,
  }

  const read: SchemaBodyReader = async (source, contentType, maxBodyBytes, protoPoisoning) => {
    const boundary = boundaryOf(contentType)
    if (boundary === undefined) {
      // Not a multipart body: a reader the schema already carried for another media type takes it.
      return inner === undefined
        ? plainError(415, "unsupported_media_type")
        : inner(source, contentType, maxBodyBytes, protoPoisoning)
    }
    if (boundary === null) return INVALID()

    const read = await readBoundedBytes(source, maxBodyBytes)
    if (!read.ok) return plainError(read.status, read.error)
    const bytes = read.bytes

    // Counted on the raw bytes: the parser allocates per part, so a body of many tiny parts must be
    // refused before it is parsed, not after.
    const delimiter = new Uint8Array(boundary.length + 2)
    delimiter[0] = DASH
    delimiter[1] = DASH
    for (let i = 0; i < boundary.length; i++) delimiter[i + 2] = boundary.charCodeAt(i)
    const found = scanDelimiters(bytes, delimiter, delimiterLimits)
    if (overLimits(found.at.length, found.empty, delimiterLimits)) {
      return plainError(413, "too_many_parts")
    }
    // A body that stops before `--boundary--` is refused with the rest, because a reader that
    // tolerated it would hand back the parts it saw as if they were the whole form.
    const parts = partsOf(bytes, found.at, delimiter.length)
    if (parts === undefined) return INVALID()

    const record = Object.create(null) as Record<string, MultipartValue>
    let fields = 0
    let files = 0
    for (const part of parts) {
      const name = part.name
      if (name === "__proto__" && protoPoisoning !== "ignore") {
        if (protoPoisoning === "reject") return INVALID()
        continue
      }
      const size = part.end - part.start
      let value: string | File
      if (part.filename === null) {
        if (++fields > maxFields) return plainError(413, "too_many_fields")
        if (size > maxFieldBytes) return plainError(413, "field_too_large")
        value = textOf(bytes, part.start, part.end)
      } else {
        // A file input left empty still submits a part with no bytes, so an empty file is that input.
        if (size === 0) continue
        if (++files > maxFiles) return plainError(413, "too_many_files")
        if (size > maxFileBytes) return plainError(413, "file_too_large")
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: readBoundedBytes allocates its own ArrayBuffer, never a shared one.
        const content = bytes.subarray(part.start, part.end) as Uint8Array<ArrayBuffer>
        value = fileOf(content, safeFileName(part.filename), part.type ?? "text/plain")
      }
      const existing = record[name]
      if (existing === undefined) record[name] = value
      else if (Array.isArray(existing)) existing.push(value)
      else record[name] = [existing, value]
    }
    return record
  }
  const mediaTypes = inner?.mediaTypes
  return mediaTypes === undefined
    ? read
    : Object.defineProperty(read, "mediaTypes", { value: mediaTypes })
}

/**
 * Opt a route's body schema into `multipart/form-data`. Returns a copy of `schema` that also reads
 * multipart bodies; the schema itself is not changed, and JSON and urlencoded bodies still reach it.
 * Opting in a schema that already was replaces its limits, and a schema that reads another media
 * type through a parser of its own keeps reading it.
 *
 * Throws a `RangeError` for a limit that is not a non-negative safe integer.
 */
export function multipartBody<Schema extends StandardSchemaV1>(
  schema: Schema,
  limits: MultipartLimits = {},
): Schema {
  const carried = (schema as { readonly [SCHEMA_BODY_READER]?: SchemaBodyReader })[
    SCHEMA_BODY_READER
  ]
  const reader: PropertyDescriptor = {
    value: createReader(limits, typeof carried === "function" ? carried : undefined),
  }
  if (typeof schema === "function") {
    // A callable schema cannot be copied; an object that delegates to it reads the same.
    return Object.defineProperty(Object.create(schema), SCHEMA_BODY_READER, reader) as Schema
  }
  // The reader goes in with the copied properties rather than after them: a schema that was already
  // opted in carries a reader that cannot be redefined, and the limits given here replace its own.
  return Object.create(Object.getPrototypeOf(schema), {
    ...Object.getOwnPropertyDescriptors(schema),
    [SCHEMA_BODY_READER]: reader,
  }) as Schema
}
