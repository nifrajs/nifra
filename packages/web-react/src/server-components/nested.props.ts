import type { StandardIssue, StandardResult, StandardSchemaV1 } from "@nifrajs/core/schema"

interface NestedServerComponentProps {
  readonly instance: string
  readonly html: string
}

const own = (value: object, key: string): unknown =>
  Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined

function validate(value: unknown): StandardResult<NestedServerComponentProps> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { issues: [{ message: "Expected object" }] }
  }
  const issues: StandardIssue[] = []
  for (const key of Object.keys(value)) {
    if (key !== "instance" && key !== "html") {
      issues.push({ message: "Unexpected property", path: [key] })
    }
  }
  const instance = own(value, "instance")
  const html = own(value, "html")
  if (typeof instance !== "string") issues.push({ message: "Expected string", path: ["instance"] })
  if (typeof html !== "string") issues.push({ message: "Expected string", path: ["html"] })
  return typeof instance === "string" && typeof html === "string" && issues.length === 0
    ? { value: { instance, html } }
    : { issues }
}

/** Written by hand so the adapter needs no schema library: the guard reads the closed shape from
 * `jsonSchema` and checks values with `validate`, so the two must describe the same object. */
export const NestedServerComponent: StandardSchemaV1<NestedServerComponentProps> & {
  readonly jsonSchema: Readonly<Record<string, unknown>>
} = {
  "~standard": { version: 1, vendor: "nifra", validate },
  jsonSchema: {
    type: "object",
    properties: { instance: { type: "string" }, html: { type: "string" } },
    required: ["instance", "html"],
    additionalProperties: false,
  },
}
