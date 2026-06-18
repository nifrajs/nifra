/**
 * The Standard Schema v1 interface (https://standardschema.dev), vendored as
 * types + a tiny runtime helper so any compliant validator — zod, valibot,
 * arktype, … — validates requests without coupling the framework to one lib.
 * The spec is MIT-licensed and explicitly designed to be copied.
 */

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaProps<Input, Output>
}

export interface StandardSchemaProps<Input = unknown, Output = Input> {
  readonly version: 1
  readonly vendor: string
  readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>
  readonly types?: StandardTypes<Input, Output> | undefined
}

export type StandardResult<Output> = StandardSuccess<Output> | StandardFailure

export interface StandardSuccess<Output> {
  readonly value: Output
  readonly issues?: undefined
}

export interface StandardFailure {
  readonly issues: ReadonlyArray<StandardIssue>
}

export interface StandardIssue {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | StandardPathSegment> | undefined
}

export interface StandardPathSegment {
  readonly key: PropertyKey
}

export interface StandardTypes<Input = unknown, Output = Input> {
  readonly input: Input
  readonly output: Output
}

export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
  Schema["~standard"]["types"]
>["output"]

export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
  Schema["~standard"]["types"]
>["input"]

export type ValidationOutcome<Output> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly issues: ReadonlyArray<StandardIssue> }

function normalizeStandardResult<Output>(
  result: StandardResult<Output>,
): ValidationOutcome<Output> {
  if (result.issues !== undefined) {
    return { ok: false, issues: result.issues }
  }
  return { ok: true, value: result.value }
}

/** Run a Standard Schema and normalize the result. Sync validators stay sync; async validators are awaited. */
export function validateStandard<Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
): ValidationOutcome<InferOutput<Schema>> | Promise<ValidationOutcome<InferOutput<Schema>>> {
  const result = schema["~standard"].validate(value)
  return result instanceof Promise
    ? result.then((settled) =>
        normalizeStandardResult(settled as StandardResult<InferOutput<Schema>>),
      )
    : normalizeStandardResult(result as StandardResult<InferOutput<Schema>>)
}
