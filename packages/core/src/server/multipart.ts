/**
 * Typed `multipart/form-data` request bodies - `multipartBody(schema, limits?)`.
 *
 * A route reads JSON and urlencoded bodies by default and answers `415` to everything else. Wrapping
 * its body schema opts that one route into multipart: the parts are read under the route's
 * `bodyLimit`, bounded by count and size, collected into one record, and handed to the schema.
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
const QUOTE = 34
const BACKSLASH = 92
const SLASH = 47
const SEMICOLON = 59
const SPACE = 32
const TAB = 9

const INVALID = (): ResponseResult => plainError(400, "invalid_multipart")

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

/** What a scan for `--boundary` found: how many, and whether the last one closes the body. */
interface Delimiters {
  readonly count: number
  readonly closed: boolean
}

/** `end` is the index after the last delimiter, or -1 when there was none. */
function delimiters(bytes: Uint8Array, count: number, end: number): Delimiters {
  return { count, closed: end !== -1 && bytes[end] === DASH && bytes[end + 1] === DASH }
}

/** Knuth-Morris-Pratt from `start`: linear in the input whatever the pattern repeats. */
function scanFrom(
  bytes: Uint8Array,
  pattern: Uint8Array,
  start: number,
  counted: number,
  lastEnd: number,
  limit: number,
): Delimiters {
  const table = failureTable(pattern)
  const size = pattern.length
  let count = counted
  let end = lastEnd
  for (let i = start, k = 0; i < bytes.length; i++) {
    const byte = bytes[i]
    while (k > 0 && byte !== pattern[k]) k = table[k - 1]!
    if (byte === pattern[k]) k++
    if (k === size) {
      end = i + 1
      if (++count > limit) break
      k = 0
    }
  }
  return delimiters(bytes, count, end)
}

/**
 * Find the non-overlapping occurrences of `pattern` (which starts with a dash), stopping once the
 * count passes `limit`. Every `--boundary` is counted wherever it sits, which is at least what any
 * parser can treat as a delimiter.
 *
 * The native search for the next dash skips binary content at memory speed. A body built to make
 * the verify loop re-read the same bytes (dashes against a boundary of dashes) spends a budget of
 * one pass over the input, then the scan continues with the linear matcher.
 */
function scanDelimiters(bytes: Uint8Array, pattern: Uint8Array, limit: number): Delimiters {
  const size = pattern.length
  const last = bytes.length - size
  let count = 0
  let end = -1
  let work = 0
  let i = 0
  while (i <= last) {
    i = bytes.indexOf(DASH, i)
    if (i === -1 || i > last) break
    let k = 1
    while (k < size && bytes[i + k] === pattern[k]) k++
    if (k === size) {
      i += size
      end = i
      if (++count > limit) break
      continue
    }
    work += k
    if (work > bytes.length) return scanFrom(bytes, pattern, i, count, end, limit)
    i++
  }
  return delimiters(bytes, count, end)
}

/** True when `value` takes more than `max` bytes as UTF-8. */
function exceedsUtf8(value: string, max: number): boolean {
  const length = value.length
  // A UTF-16 code unit is one to three UTF-8 bytes, so most values are decided without a walk.
  if (length > max) return true
  if (length * 3 <= max) return false
  let bytes = 0
  for (let i = 0; i < length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < length) {
      const low = value.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
    if (bytes > max) return true
  }
  return false
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

/** `part` as a `File` called `name`, keeping its bytes, type, and timestamp. */
function renamedFile(part: Blob, name: string): File {
  const modified = (part as Partial<File>).lastModified
  const options: FilePropertyBag =
    modified === undefined ? { type: part.type } : { type: part.type, lastModified: modified }
  let file = new File([part], name, options)
  // A runtime may hand back the single source part with its own name when nothing else changes;
  // a second, empty part forces a new file.
  if (file.name !== name) file = new File([part, ""], name, options)
  if (file.name !== name || file.size !== part.size) {
    throw new Error("multipartBody: this runtime did not apply a file name")
  }
  return file
}

function createReader(
  limits: MultipartLimits,
  inner: SchemaBodyReader | undefined,
): SchemaBodyReader {
  const maxFields = limitOf(limits.maxFields, DEFAULT_MAX_FIELDS, "maxFields")
  const maxFiles = limitOf(limits.maxFiles, DEFAULT_MAX_FILES, "maxFiles")
  const maxFieldBytes = limitOf(limits.maxFieldBytes, DEFAULT_MAX_FIELD_BYTES, "maxFieldBytes")
  const maxFileBytes = limitOf(limits.maxFileBytes, UNLIMITED_BODY_BYTES, "maxFileBytes")
  // Every part sits between two delimiters, and the last delimiter closes the body.
  const maxDelimiters = maxFields + maxFiles + 1

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
    if (!read.ok) {
      return read.status === 413
        ? plainError(413, "payload_too_large")
        : plainError(400, "invalid_content_length")
    }
    const bytes = read.bytes

    // Counted on the raw bytes: the platform parser allocates per part, so a body of many tiny
    // parts must be refused before it is parsed, not after.
    const delimiter = new Uint8Array(boundary.length + 2)
    delimiter[0] = DASH
    delimiter[1] = DASH
    for (let i = 0; i < boundary.length; i++) delimiter[i + 2] = boundary.charCodeAt(i)
    const found = scanDelimiters(bytes, delimiter, maxDelimiters)
    if (found.count > maxDelimiters) return plainError(413, "too_many_parts")
    // A body is over when `--boundary--` says so. One that stops short is refused here, because a
    // parser that tolerates it hands back the parts it saw as if they were the whole form.
    if (!found.closed) return INVALID()

    // The parser is given the boundary this reader extracted, never the request's own header: two
    // readings of one header (a repeated or oddly quoted parameter) would let a body be counted
    // under one boundary and parsed under another.
    const canonical = `${MEDIA_TYPE}; boundary=${TOKEN.test(boundary) ? boundary : `"${boundary}"`}`
    // Typed by what is read from it: the global `FormData` and `BodyInit` names do not resolve to
    // the same declarations under every lib config.
    let form: Iterable<[string, string | Blob]>
    try {
      form = (await new Response(bytes as ConstructorParameters<typeof Response>[0], {
        headers: { "content-type": canonical },
      }).formData()) as unknown as Iterable<[string, string | Blob]>
    } catch {
      return INVALID()
    }

    const record = Object.create(null) as Record<string, MultipartValue>
    let fields = 0
    let files = 0
    for (const [name, part] of form) {
      if (name === "__proto__" && protoPoisoning !== "ignore") {
        if (protoPoisoning === "reject") return INVALID()
        continue
      }
      let value: string | File
      if (typeof part === "string") {
        if (++fields > maxFields) return plainError(413, "too_many_fields")
        if (exceedsUtf8(part, maxFieldBytes)) return plainError(413, "field_too_large")
        value = part
      } else {
        // A file input left empty still submits a part with no bytes. Runtimes disagree on whether
        // a named empty file keeps its name, so every empty file is treated as that input.
        if (part.size === 0) continue
        const rawName = (part as Partial<File>).name
        const clientName = typeof rawName === "string" ? rawName : ""
        if (++files > maxFiles) return plainError(413, "too_many_files")
        if (part.size > maxFileBytes) return plainError(413, "file_too_large")
        const name = safeFileName(clientName)
        value = part instanceof File && part.name === name ? part : renamedFile(part, name)
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
