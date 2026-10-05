import type { StandardSchemaV1 } from "@nifrajs/core/schema"
import { outputGuard, runGuard } from "../internal/output-guard.ts"
import { assertComponentSchema } from "./schema.ts"
import { componentValue } from "./value.ts"

const guards = new WeakMap<object, ReturnType<typeof outputGuard>>()

export async function guardComponentProps(
  schema: StandardSchemaV1,
  value: unknown,
): Promise<unknown> {
  let guard = guards.get(schema)
  if (guard === undefined) {
    assertComponentSchema(schema)
    guard = outputGuard(schema, "client component", "props")
    guards.set(schema, guard)
  }
  return componentValue(await runGuard(guard, value, "client component props"))
}
