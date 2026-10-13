import type * as TS from "typescript"

/** Whether a loaded `typescript` module carries the in-process compiler API (TypeScript 7's does not). */
export function isTypeScriptCompiler(value: unknown): value is typeof TS {
  return (
    typeof value === "object" &&
    value !== null &&
    "createSourceFile" in value &&
    typeof value.createSourceFile === "function"
  )
}
