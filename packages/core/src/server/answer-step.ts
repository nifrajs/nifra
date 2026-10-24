import { RouteConfigError } from "../errors.ts"
import type { RouteSchema } from "./context.ts"

/**
 * A schema's own step around a route's handler, for a schema that changes how the answer it describes
 * is written: `t.bytes()` has every `Uint8Array` leave as base64. It sits on the schema's `validate`,
 * so a spread copy keeps it, and is read once, at registration.
 */
const ANSWER_STEP = Symbol.for("nifra.schema.answerStep")

/** The part of a request's context a step reads: the `c.json(...)` reply it made, and its value. */
export interface JsonReplyContext {
  readonly jsonReply: Response | undefined
  readonly jsonBody: unknown
  json(body: unknown, init?: ResponseInit): Response
}

export interface AnswerStep {
  /** Why the schema cannot describe a request or an event stream, and what to use there instead. */
  readonly misplaced: string
  readonly wrap: <C extends JsonReplyContext>(
    handler: (context: C) => unknown,
  ) => (context: C) => unknown
}

function stepOf(schema: object | undefined): AnswerStep | undefined {
  const validate = schema === undefined ? undefined : Reflect.get(schema, "~standard")?.validate
  return typeof validate === "function" ? Reflect.get(validate, ANSWER_STEP) : undefined
}

const REQUEST_FIELDS = ["params", "headers", "cookies", "query", "body", "sse"] as const

/** `handler` wrapped by each step its route's `response` and `errors` schemas carry. */
export function withAnswerSteps<C extends JsonReplyContext>(
  schema: RouteSchema | undefined,
  method: string,
  path: string,
  handler: (context: C) => unknown,
): (context: C) => unknown {
  if (schema === undefined) return handler
  for (const field of REQUEST_FIELDS) {
    const step = stepOf(schema[field])
    if (step !== undefined) {
      throw new RouteConfigError(
        "RESPONSE_ONLY_SCHEMA",
        `route ${method} ${path}, \`${field}\`: ${step.misplaced}`,
      )
    }
  }
  const steps = new Set<AnswerStep["wrap"]>()
  for (const answer of [schema.response, ...Object.values(schema.errors ?? {})]) {
    const step = stepOf(answer)
    if (step !== undefined) steps.add(step.wrap)
  }
  for (const wrap of steps) handler = wrap(handler)
  return handler
}
