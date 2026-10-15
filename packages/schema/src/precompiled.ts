import type { StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core/schema"
import type { Static, TSchema } from "@sinclair/typebox"
import { FormatRegistry } from "@sinclair/typebox"
import { Errors } from "@sinclair/typebox/errors"
import { ensureDefaultFormats } from "./formats.ts"

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
  return {
    jsonSchema: schema,
    "~standard": {
      version: 1,
      vendor: "nifra",
      validate(value: unknown): StandardResult<Static<T>> {
        ensureDefaultFormats()
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The generated checker was compiled from this exact schema at build time.
        if (check(value)) return { value: value as Static<T> }
        const issues = []
        for (const error of Errors(schema, value)) {
          issues.push({
            message: error.message,
            path: error.path === "" ? undefined : error.path.slice(1).split("/"),
          })
          if (issues.length === 100) break
        }
        return { issues }
      },
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: `types` is a phantom carrying the source schema's Static<T>; no runtime value is ever read from it.
      types: undefined as unknown as StandardTypes<Static<T>, Static<T>>,
    },
  }
}
