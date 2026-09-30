/**
 * `@nifrajs/schema/form` - `t` with file fields and `multipart/form-data` bodies.
 *
 * The `t` exported here is the builder from `@nifrajs/schema` plus `t.file` and `t.form`. A file is
 * not JSON, so TypeBox cannot check one: `t.file` carries its own validator and marks its JSON
 * Schema (`{ type: "string", format: "binary" }`) so the other constructors can tell a file field
 * apart. `t.form` is the object constructor that understands those fields - it validates the text
 * fields through TypeBox (with coercion, since every form value arrives as a string) and each file
 * field through its own validator - and it reads the multipart body itself, so it is a route's
 * `body` as is:
 *
 * ```ts
 * import { t } from "@nifrajs/schema/form"
 *
 * app.post(
 *   "/avatars",
 *   {
 *     body: t.form({
 *       avatar: t.file({ maxBytes: 5_000_000, accept: ["image/png", "image/jpeg"] }),
 *       caption: t.optional(t.string({ maxLength: 200 })),
 *     }),
 *     bodyLimit: 6_000_000,
 *   },
 *   (c) => ({ name: c.body.avatar.name, type: c.body.avatar.type }),
 * )
 * ```
 *
 * A subpath on purpose: an app that takes no uploads carries none of this.
 */
import { type MultipartLimits, multipartBody } from "@nifrajs/core/multipart"
import type { StandardIssue, StandardResult, StandardTypes } from "@nifrajs/core/schema"
import {
  DETECTABLE_MIME_TYPES,
  detectFileType,
  FILE_TYPE_PREFIX_BYTES,
} from "@nifrajs/uploads/detect"
import {
  type ArrayOptions,
  Kind,
  OptionalKind,
  type Static,
  type TObject,
  type TSchema,
  type TUnsafe,
  Type,
} from "@sinclair/typebox"
import { fromTypeBox, type NifraSchema } from "./adapter.ts"
import { FILE, FILE_OPS, type FileOps, isFileSchema } from "./file-kind.ts"
import { t as base } from "./t.ts"

type Validate = (value: unknown) => StandardResult<unknown> | Promise<StandardResult<unknown>>

export interface FileOptions {
  /** Largest accepted size in bytes. Omit for no bound beyond the route's `bodyLimit`. */
  readonly maxBytes?: number
  /**
   * Accepted types, matched against the file's leading bytes - never against the type the client
   * claimed. Each entry is an exact type (`"image/png"`) or a subtype wildcard (`"image/*"`), and has
   * to be one the bytes can prove: a type with no signature (`text/csv`, `image/svg+xml`) or a
   * catch-all wildcard throws here rather than rejecting every upload later. With `accept` set, the
   * validated file's `type` is the detected one.
   */
  readonly accept?: readonly string[]
}

/**
 * The multipart limits (`maxFields`, `maxFiles`, `maxFieldBytes`, `maxFileBytes`) bound what the body
 * may carry before any of it is validated; a request over one is answered `413`.
 */
export interface FormOptions extends MultipartLimits {
  /** Accept fields the form does not declare. Defaults to `false`: an undeclared field fails validation. */
  readonly additionalProperties?: boolean
  readonly title?: string
  readonly description?: string
}

const fail = (message: string): StandardResult<never> => ({ issues: [{ message }] })

const matches = (mime: string, pattern: string): boolean =>
  pattern === mime || (pattern.endsWith("/*") && mime.startsWith(pattern.slice(0, -1)))

function custom<T extends TSchema>(jsonSchema: T, validate: Validate): NifraSchema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "nifra",
      validate: validate as NifraSchema<T>["~standard"]["validate"],
      // Phantom, as in `fromTypeBox`: read by `InferOutput` at compile time only.
      types: undefined as unknown as StandardTypes<Static<T>, Static<T>>,
    },
    jsonSchema,
  }
}

/** A file schema: `t.array` and `t.optional` find their file-aware versions on it. */
function fileKind<T extends TSchema>(jsonSchema: T, validate: Validate): NifraSchema<T> {
  return Object.defineProperty(custom(jsonSchema, validate), FILE_OPS, { value: OPS })
}

function assertCount(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
}

function acceptList(accept: readonly string[]): readonly string[] {
  if (!Array.isArray(accept) || accept.length === 0) {
    throw new TypeError("t.file: accept must list at least one type")
  }
  for (const pattern of accept) {
    if (
      typeof pattern !== "string" ||
      !DETECTABLE_MIME_TYPES.some((mime) => matches(mime, pattern))
    ) {
      throw new TypeError(
        `t.file: accept ${JSON.stringify(pattern)} cannot be checked against a file's bytes. ` +
          `Use one of ${DETECTABLE_MIME_TYPES.join(", ")}, or a wildcard over them such as "image/*"`,
      )
    }
  }
  return [...accept]
}

/**
 * The same file under a different `type`. The result is verified rather than trusted: a runtime
 * that ignores the requested type must not hand the handler a file still labelled by the client.
 */
function typedFile(file: File, type: string): File {
  const options: FilePropertyBag = { type, lastModified: file.lastModified }
  let typed = new File([file], file.name, options)
  if (typed.name !== file.name || typed.type !== type) {
    typed = new File([file, ""], file.name, options)
  }
  if (typed.name !== file.name || typed.type !== type || typed.size !== file.size) {
    throw new Error("t.file: this runtime did not apply a file type")
  }
  return typed
}

/**
 * The part of a file the signature check reads, named structurally: the global `Blob` does not
 * declare `slice` under every lib config.
 */
type Sliceable = { slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } }

async function sniff(file: File, accept: readonly string[]): Promise<StandardResult<File>> {
  // Only the leading bytes are read, whatever the file's size.
  const source = file as unknown as Sliceable
  const head = new Uint8Array(await source.slice(0, FILE_TYPE_PREFIX_BYTES).arrayBuffer())
  const detected = detectFileType(head)
  if (detected === null) return fail("File type could not be recognized")
  if (!accept.some((pattern) => matches(detected.mime, pattern))) {
    return fail(`File type ${detected.mime} is not accepted`)
  }
  return { value: file.type === detected.mime ? file : typedFile(file, detected.mime) }
}

function file(options: FileOptions = {}): NifraSchema<TUnsafe<File>> {
  const { maxBytes } = options
  assertCount(maxBytes, "t.file: maxBytes")
  const accept = options.accept === undefined ? undefined : acceptList(options.accept)
  return fileKind(
    Type.Unsafe<File>({ type: "string", format: "binary", [FILE]: true }),
    (value) => {
      if (!(value instanceof File)) return fail("Expected a file")
      if (maxBytes !== undefined && value.size > maxBytes) {
        return fail(`File is larger than ${maxBytes} bytes`)
      }
      // Reading bytes is the only asynchronous step, so a file with no `accept` validates in place.
      return accept === undefined ? { value } : sniff(value, accept)
    },
  )
}

function optionalFile(schema: NifraSchema): NifraSchema {
  const inner: Validate = schema["~standard"].validate
  return fileKind(Type.Optional(schema.jsonSchema), (value) =>
    value === undefined ? { value } : inner(value),
  )
}

/** Run one validator per entry; synchronous unless an entry has bytes to read. */
function validateEach(
  count: number,
  run: (index: number) => StandardResult<unknown> | Promise<StandardResult<unknown>>,
  path: (index: number) => PropertyKey,
  issues: StandardIssue[],
  keep: (index: number, value: unknown) => void,
): undefined | Promise<void> {
  // Results are gathered by position and reported in order, so the issue list does not depend on
  // which read finished first.
  const results = new Array<StandardResult<unknown>>(count)
  const pending: Array<Promise<void>> = []
  for (let index = 0; index < count; index++) {
    const result = run(index)
    if (result instanceof Promise) {
      pending.push(
        result.then((settled) => {
          results[index] = settled
        }),
      )
    } else {
      results[index] = result
    }
  }
  const report = (): void => {
    for (let index = 0; index < count; index++) {
      const result = results[index] as StandardResult<unknown>
      if (result.issues === undefined) {
        keep(index, result.value)
        continue
      }
      for (const issue of result.issues) {
        issues.push({ message: issue.message, path: [path(index), ...(issue.path ?? [])] })
      }
    }
  }
  if (pending.length === 0) {
    report()
    return undefined
  }
  return Promise.all(pending).then(report)
}

const UNSUPPORTED_ARRAY_OPTIONS = ["uniqueItems", "contains", "minContains", "maxContains"] as const

function fileArray(item: NifraSchema, options?: ArrayOptions): NifraSchema {
  if ((item.jsonSchema as { readonly [FILE]?: true })[FILE] !== true) {
    throw new TypeError("t.array: a list of files cannot be nested inside another list")
  }
  for (const name of UNSUPPORTED_ARRAY_OPTIONS) {
    if (options?.[name] !== undefined) {
      throw new TypeError(`t.array: ${name} is not supported for a list of files`)
    }
  }
  const minItems = options?.minItems
  const maxItems = options?.maxItems
  assertCount(minItems, "t.array: minItems")
  assertCount(maxItems, "t.array: maxItems")
  const inner: Validate = item["~standard"].validate
  return fileKind(Type.Array(item.jsonSchema, options), (value) => {
    if (!Array.isArray(value)) return fail("Expected a list of files")
    if (minItems !== undefined && value.length < minItems) {
      return fail(`Expected at least ${minItems} file(s)`)
    }
    if (maxItems !== undefined && value.length > maxItems) {
      return fail(`Expected at most ${maxItems} file(s)`)
    }
    const issues: StandardIssue[] = []
    const output = new Array<unknown>(value.length)
    const finish = (): StandardResult<unknown> =>
      issues.length > 0 ? { issues } : { value: output }
    const pending = validateEach(
      value.length,
      (index) => inner(value[index]),
      (index) => index,
      issues,
      (index, entry) => {
        output[index] = entry
      },
    )
    return pending === undefined ? finish() : pending.then(finish)
  })
}

// Function declarations, so the table can sit above the constructors that hand it out.
const OPS: FileOps = { optional: optionalFile, array: fileArray }

type Props = Record<string, NifraSchema>
type FormShape<P extends Props> = TObject<{ [K in keyof P]: P[K]["jsonSchema"] }>

interface FileField {
  readonly key: string
  readonly validate: Validate
  readonly list: boolean
  readonly required: boolean
}

/**
 * What a file field was sent, with the inputs nobody filled in taken out. A browser submits such an
 * input as an empty file, which never reaches a schema; some clients send an empty text part in its
 * place, and that names no file either.
 */
function given(entry: unknown): unknown {
  if (entry === "") return undefined
  if (!Array.isArray(entry) || !entry.includes("")) return entry
  const filled = entry.filter((value) => value !== "")
  return filled.length === 0 ? undefined : filled
}

function form<P extends Props>(props: P, options?: FormOptions): NifraSchema<FormShape<P>> {
  const files: FileField[] = []
  const fileKeys = new Set<string>()
  /** Required text lists: a list nobody filled in is sent as no field at all, which means empty. */
  const lists: string[] = []
  const text: Record<string, TSchema> = {}
  const all: Record<string, TSchema> = {}
  for (const [key, schema] of Object.entries(props)) {
    // Assigning this key to an ordinary object would replace its prototype instead of adding a field.
    if (key === "__proto__") throw new TypeError('t.form: "__proto__" cannot be a field name')
    const node = schema.jsonSchema
    const marks = node as unknown as { readonly [Kind]?: string; readonly [OptionalKind]?: string }
    const list = marks[Kind] === "Array"
    const required = marks[OptionalKind] !== "Optional"
    all[key] = node
    if (isFileSchema(node)) {
      files.push({ key, validate: schema["~standard"].validate, list, required })
      fileKeys.add(key)
    } else {
      text[key] = node
      if (list && required) lists.push(key)
    }
  }
  const objectOptions = {
    ...(options?.title === undefined ? {} : { title: options.title }),
    ...(options?.description === undefined ? {} : { description: options.description }),
    additionalProperties: options?.additionalProperties === true,
  }
  // `fromTypeBox` validates synchronously; only a file with bytes to read makes a form asynchronous.
  const validateText = fromTypeBox(Type.Object(text, objectOptions), { coerce: true })["~standard"]
    .validate as (value: unknown) => StandardResult<Record<string, unknown>>

  const validate: Validate = (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return fail("Expected form fields")
    }
    const input = value as Record<string, unknown>
    // Validated on a copy with no prototype: coercion writes into the object it is given, and a
    // field named like an `Object.prototype` member has to be an ordinary field here.
    const fields: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(input)) {
      if (!fileKeys.has(key)) fields[key] = input[key]
    }
    for (const key of lists) {
      if (!(key in fields)) fields[key] = []
    }
    const checked = validateText(fields)
    const issues: StandardIssue[] = checked.issues === undefined ? [] : [...checked.issues]
    const output: Record<string, unknown> = Object.create(null)
    if (checked.issues === undefined) {
      for (const key of Object.keys(checked.value)) output[key] = checked.value[key]
    }
    const finish = (): StandardResult<unknown> =>
      issues.length > 0 ? { issues } : { value: output }
    const pending = validateEach(
      files.length,
      (index) => {
        const field = files[index] as FileField
        const entry = Object.hasOwn(input, field.key) ? given(input[field.key]) : undefined
        if (!field.list) return field.validate(entry)
        // One file under a repeatable name is a list of one; none at all is an empty list.
        if (entry === undefined) return field.validate(field.required ? [] : undefined)
        return field.validate(Array.isArray(entry) ? entry : [entry])
      },
      (index) => (files[index] as FileField).key,
      issues,
      (index, entry) => {
        if (entry !== undefined) output[(files[index] as FileField).key] = entry
      },
    )
    return pending === undefined ? finish() : pending.then(finish)
  }
  // Branded here, so the schema is a route's `body` as is: a form that did not read multipart
  // bodies would refuse every request it exists to accept.
  return multipartBody(
    custom(Type.Object(all, objectOptions) as unknown as FormShape<P>, validate),
    options,
  )
}

/** `t` from `@nifrajs/schema`, plus the two constructors a `multipart/form-data` body needs. */
export const t = {
  ...base,
  /**
   * An uploaded file, for a field of `t.form`. `maxBytes` bounds its size; `accept` allow-lists its
   * type by the file's leading bytes (not the type the client claimed) and makes the validated
   * file's `type` the detected one. Without `accept`, `file.type` is whatever the client sent.
   * `file.name` is client-chosen either way - store under a key you generate.
   *
   * Wrap it in `t.optional()` for a file that may be absent, or `t.array()` for several under one
   * name.
   */
  file,
  /**
   * A `multipart/form-data` body: text fields and `t.file()` fields side by side. Text values are
   * coerced (`"20"` -> `20`) because a form sends only strings, a name sent once satisfies a list
   * field, and a required list nobody filled in is empty rather than missing. Undeclared fields are
   * rejected unless `additionalProperties: true`.
   *
   * The result reads the multipart body itself - pass it as a route's `body`. JSON and urlencoded
   * bodies still reach it, so a form with no required file accepts those too.
   */
  form,
}
