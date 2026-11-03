import type { StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core/schema"
import type { Static, TSchema } from "@sinclair/typebox"
import { FormatRegistry } from "@sinclair/typebox"
import { Errors } from "@sinclair/typebox/errors"
import { Convert } from "@sinclair/typebox/value"
import { markAnswerStep } from "./answer-step.ts"
import { ensureDefaultFormats } from "./formats.ts"
import { namesInheritedMember, ownView } from "./inherited.ts"
import { COERCES, TEXT_SLOT } from "./marks.ts"

export { Kind, OptionalKind, ReadonlyKind } from "@sinclair/typebox"
export { Hash as compiledHash } from "@sinclair/typebox/value"

/** The format callback used by generated validators; custom formats retain their registry semantics. */
export function compiledFormat(name: string, value: string): boolean {
  ensureDefaultFormats()
  return FormatRegistry.Get(name)?.(value) ?? false
}

/** Wrap a build-generated checker without shipping a schema builder or dynamic compiler. */
export function fromPrecompiled<T extends TSchema>(
  schema: T,
  check: (value: unknown) => boolean,
): StandardSchemaV1<Static<T>, Static<T>> & { readonly jsonSchema: T } {
  // A key named after an `Object.prototype` member is checked on an own view - see ./inherited.ts.
  const ownOnly = namesInheritedMember(schema)
  const result: StandardSchemaV1<Static<T>, Static<T>> & { readonly jsonSchema: T } = {
    jsonSchema: schema,
    "~standard": {
      version: 1,
      vendor: "nifra",
      validate(value: unknown): StandardResult<Static<T>> {
        ensureDefaultFormats()
        const input = ownOnly ? ownView(value) : value
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The generated checker was compiled from this exact schema at build time.
        if (check(input)) return { value: value as Static<T> }
        const issues = []
        for (const error of Errors(schema, input)) {
          issues.push({
            message: error.message,
            path:
              error.path === ""
                ? undefined
                : error.path
                    .slice(1)
                    .split("/")
                    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~")),
          })
          if (issues.length === 100) break
        }
        return { issues }
      },
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: `types` is a phantom carrying the source schema's Static<T>; no runtime value is ever read from it.
      types: undefined as unknown as StandardTypes<Static<T>, Static<T>>,
    },
  }
  markAnswerStep(result["~standard"].validate, schema)
  // The same text form `fromTypeBox` offers a query, header or cookie slot: the values converted to
  // the schema's types, then the generated checker.
  let textForm: typeof result | undefined
  Object.defineProperty(result["~standard"].validate, TEXT_SLOT, {
    get: () => {
      if (textForm !== undefined) return textForm
      const validate = (value: unknown) =>
        result["~standard"].validate(Convert(schema, ownOnly ? ownView(value) : value))
      Object.defineProperty(validate, COERCES, { value: true })
      markAnswerStep(validate, schema)
      textForm = { ...result, "~standard": { ...result["~standard"], validate } }
      return textForm
    },
  })
  return result
}
