/**
 * How `t` tells a file field apart without carrying the code that validates one.
 *
 * File fields come from `@nifrajs/schema/form`. They mark their JSON Schema, and the schema object
 * brings its own list and optional constructors along, so `t.array` and `t.optional` handle a file
 * while an app that never takes an upload ships none of that code.
 */
import { type ArrayOptions, Kind, type TSchema } from "@sinclair/typebox"
import type { NifraSchema } from "./adapter.ts"

/** Marks the JSON Schema of a file field. Registered, so two copies of this package agree on it. */
export const FILE: unique symbol = Symbol.for("nifra.schema.file")

/** Carries the file-aware constructors on a file schema. Registered for the same reason. */
export const FILE_OPS: unique symbol = Symbol.for("nifra.schema.fileOps")

export interface FileOps {
  optional(schema: NifraSchema): NifraSchema
  array(item: NifraSchema, options?: ArrayOptions): NifraSchema
}

type Marked = { readonly [FILE]?: true; readonly [Kind]?: string; readonly items?: TSchema }

/** Whether a JSON Schema is a file field, or a list of them. */
export function isFileSchema(schema: TSchema): boolean {
  const node = schema as unknown as Marked
  return (
    node[FILE] === true ||
    (node[Kind] === "Array" && node.items !== undefined && isFileSchema(node.items))
  )
}

/** Throw when a constructor that validates JSON is handed a file field. */
export function refuseFile(where: string, schema: TSchema): void {
  if (isFileSchema(schema)) {
    throw new TypeError(`${where}: a file field belongs in t.form() from "@nifrajs/schema/form"`)
  }
}

/**
 * The file-aware constructors of a file schema, or `undefined` for any other schema. A schema whose
 * JSON Schema says "file" but which lost its validator is refused: TypeBox cannot check a file.
 */
export function fileOps(where: string, schema: NifraSchema): FileOps | undefined {
  const ops = (schema as { readonly [FILE_OPS]?: FileOps })[FILE_OPS]
  if (ops === undefined) refuseFile(where, schema.jsonSchema)
  return ops
}
