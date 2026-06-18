/**
 * Minimal Standard Schema surface (the public https://standardschema.dev v1 spec), inlined so
 * `@nifrajs/env` stays dependency-free and accepts validators from `t` (@nifrajs/schema), zod, valibot,
 * or its own coercing `env.*` helpers interchangeably.
 */

export interface StandardIssue {
  readonly message: string
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> }

export interface StandardSchemaV1<Output = unknown> {
  readonly "~standard": {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>
    readonly types?: { readonly output: Output }
  }
}

/** Extract a Standard Schema's validated output type. */
export type InferOutput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["output"]

/** Build an env validator: a Standard Schema whose `validate` coerces from `string | undefined`. */
export function envSchema<Output>(
  validate: (raw: string | undefined) => StandardResult<Output>,
): StandardSchemaV1<Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "nifra-env",
      validate: (value) => validate(value as string | undefined),
      // Phantom: carries the output type for InferOutput; no runtime value.
      types: undefined as unknown as { readonly output: Output },
    },
  }
}

/** A single issue. Messages NEVER include the variable's value — it may be a secret. */
export const issue = (message: string): { readonly issues: ReadonlyArray<StandardIssue> } => ({
  issues: [{ message }],
})
