import { type AnswerStep, withBase64Bytes } from "@nifrajs/core/binary"

/** Read by core when a route registers; see `AnswerStep` in `@nifrajs/core/binary`. */
const ANSWER_STEP = Symbol.for("nifra.schema.answerStep")
/** The JSON Schema key `t.bytes()` sets. */
export const BYTES_KEY = "x-nifra-bytes"
// Deeper than any real schema.
const MAX_DEPTH = 64

const BASE64_STEP: AnswerStep = {
  misplaced:
    't.bytes() is for a response field; take the base64 text as t.string({ contentEncoding: "base64" }) and decode it in the handler',
  wrap: withBase64Bytes,
}

function declaresBytes(node: unknown, depth: number): boolean {
  if (typeof node !== "object" || node === null || depth > MAX_DEPTH) return false
  if (Reflect.get(node, BYTES_KEY) === true) return true
  for (const child of Object.values(node)) if (declaresBytes(child, depth + 1)) return true
  return false
}

/**
 * Give `validate` the step core reads for a `t.bytes()` field anywhere in `jsonSchema`. A getter, so a
 * schema is walked only when a route asks, once; every nested `t.*` builder makes a schema of its own.
 */
export function markAnswerStep(validate: object, jsonSchema: object): void {
  let step: AnswerStep | null | undefined
  Object.defineProperty(validate, ANSWER_STEP, {
    get: () => {
      step ??= declaresBytes(jsonSchema, 0) ? BASE64_STEP : null
      return step ?? undefined
    },
  })
}
