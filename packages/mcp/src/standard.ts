/**
 * The Standard Schema v1 interface (https://standardschema.dev), vendored as types + a tiny
 * runtime so any compliant validator - nifra's `t`, zod, valibot, arktype, … - can type and
 * validate tool arguments without coupling this package to a validator. The spec is MIT-licensed
 * and explicitly designed to be copied; this package stays dependency-free.
 */

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>
    readonly types?: { readonly input: Input; readonly output: Output } | undefined
  }
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> }

export interface StandardIssue {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}

/** The validated (post-transform) type of a Standard Schema. */
export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
  Schema["~standard"]["types"]
>["output"]

/** Render issues as one agent-readable line per problem: `location: message`. */
export function formatIssues(issues: ReadonlyArray<StandardIssue>): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((seg) => String(typeof seg === "object" && seg !== null ? seg.key : seg))
        .join(".")
      return path === "" ? issue.message : `${path}: ${issue.message}`
    })
    .join("; ")
}

/**
 * The wire JSON Schema of a Standard Schema, when it carries one. nifra's `t` schemas ARE
 * JSON Schema (exposed as `.jsonSchema`), so tools authored with `t` advertise a full
 * `inputSchema` for free. Schemas from other vendors return `undefined` - pass an explicit
 * `inputSchema` alongside `input` for those.
 */
export function jsonSchemaOf(schema: StandardSchemaV1): Record<string, unknown> | undefined {
  const candidate = (schema as { jsonSchema?: unknown }).jsonSchema
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : undefined
}
