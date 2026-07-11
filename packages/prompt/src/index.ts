/**
 * `@nifrajs/prompt` — type-safe prompts over any LLM provider.
 *
 * A prompt binds an instruction to an INPUT schema (the variables it needs) and an OUTPUT schema
 * (the shape the model must return). Both are Standard Schemas — the same `t` contracts routes use —
 * so the compile-time types and the runtime validation come from one definition, and the output
 * schema's JSON Schema is handed to the provider as its structured-output format.
 *
 * Provider-neutral by design: `run` takes a `complete` function `(request) => Promise<string>` and
 * this package never imports a vendor SDK. Adapters are one-liners:
 *
 *   const extract = prompt("Extract the contact from the text.")
 *     .input(t.object({ text: t.string() }))
 *     .output(t.object({ name: t.string(), email: t.string({ format: "email" }) }))
 *
 *   const contact = await extract.run({ text }, {
 *     complete: async ({ messages, responseFormat }) => {
 *       const res = await openai.chat.completions.create({
 *         model: "gpt-5",
 *         messages,
 *         response_format: { type: "json_schema", json_schema: responseFormat },
 *       })
 *       return res.choices[0].message.content ?? ""
 *     },
 *   })
 *   // contact: { name: string; email: string } — parsed, never cast.
 *
 * The model's reply is parsed (markdown fences stripped) and validated through the output schema's
 * own `~standard.validate`; failures throw {@link PromptOutputError} with the issues, or feed an
 * optional `heal` hook for provider-side repair retries.
 */

import {
  type InferOutput,
  type JsonSchema,
  reflectSchema,
  type StandardIssue,
  type StandardSchemaV1,
  validateStandard,
} from "@nifrajs/core"

/** One chat message. The union every provider API accepts. */
export interface PromptMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
}

/** The structured-output format handed to the provider (OpenAI `json_schema` shape; trivially
 * adaptable to Anthropic tool-input or Gemini `responseSchema`). */
export interface PromptResponseFormat {
  readonly name: string
  readonly strict: true
  readonly schema: JsonSchema
}

/** Everything a provider adapter needs to execute one prompt call. */
export interface PromptRequest {
  readonly messages: readonly PromptMessage[]
  /** Present when the prompt declares `.output()` — pass it as the provider's structured-output format. */
  readonly responseFormat?: PromptResponseFormat
}

export interface RunOptions {
  /** Execute the LLM call and return the raw text of the model's reply. */
  readonly complete: (request: PromptRequest) => string | Promise<string>
  /**
   * Repair hook: called when the reply fails output validation, with the raw reply and the issues.
   * Return a corrected raw reply (e.g. by re-asking the model) — it is validated again. Runs at most
   * `healAttempts` times (default 1). Omit to fail fast.
   */
  readonly heal?: (context: {
    readonly raw: string
    readonly issues: ReadonlyArray<StandardIssue>
    readonly request: PromptRequest
  }) => string | Promise<string>
  /** Max heal retries after the first failed validation (default 1). */
  readonly healAttempts?: number
  /** Extra messages appended after the instruction (few-shot examples, prior turns). */
  readonly messages?: readonly PromptMessage[]
}

/** A failed prompt input — the caller's variables did not satisfy the input schema. */
export class PromptInputError extends Error {
  constructor(readonly issues: ReadonlyArray<StandardIssue>) {
    super(`prompt input failed validation: ${issues.map((issue) => issue.message).join("; ")}`)
    this.name = "PromptInputError"
  }
}

/** The model's reply did not satisfy the output schema (after any heal attempts). */
export class PromptOutputError extends Error {
  constructor(
    readonly issues: ReadonlyArray<StandardIssue>,
    /** The raw model reply that failed, for logging/debugging. */
    readonly raw: string,
  ) {
    super(`prompt output failed validation: ${issues.map((issue) => issue.message).join("; ")}`)
    this.name = "PromptOutputError"
  }
}

/**
 * Strip a single markdown code fence (```json … ``` or ``` … ```) wrapping the reply — the most
 * common structured-output failure mode even with response formats.
 */
function unfence(raw: string): string {
  const trimmed = raw.trim()
  const match = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return match?.[1] ?? trimmed
}

const jsonSchemaOf = (schema: StandardSchemaV1, role: string): JsonSchema => {
  const reflected = reflectSchema(schema).jsonSchema
  if (reflected === undefined) {
    throw new Error(
      `prompt ${role} schema exposes no JSON Schema metadata — use a t/TypeBox schema (or a raw JSON Schema carrier); a validation-only schema cannot be sent to a provider`,
    )
  }
  return reflected
}

export interface Prompt<Input, Output> {
  readonly instruction: string
  /** Declare the variables the prompt needs. Validated on every run. */
  input<Schema extends StandardSchemaV1>(schema: Schema): Prompt<InferOutput<Schema>, Output>
  /** Declare the shape the model must return. Sent as the provider's structured-output format. */
  output<Schema extends StandardSchemaV1>(schema: Schema): Prompt<Input, InferOutput<Schema>>
  /** Build the provider request without executing it (for inspection, logging, tests). */
  request(input: Input, extraMessages?: readonly PromptMessage[]): Promise<PromptRequest>
  /** Execute via the given provider `complete` fn and return the validated, typed output. */
  run(input: Input, options: RunOptions): Promise<Output>
}

interface PromptState {
  readonly instruction: string
  readonly inputSchema?: StandardSchemaV1
  readonly outputSchema?: StandardSchemaV1
}

function build<Input, Output>(state: PromptState): Prompt<Input, Output> {
  const buildRequest = async (
    input: Input,
    extraMessages: readonly PromptMessage[] = [],
  ): Promise<PromptRequest> => {
    let value: unknown = input
    if (state.inputSchema !== undefined) {
      const outcome = await validateStandard(state.inputSchema, input)
      if (!outcome.ok) throw new PromptInputError(outcome.issues)
      value = outcome.value
    }
    const messages: PromptMessage[] = [{ role: "system", content: state.instruction }]
    if (state.inputSchema !== undefined || value !== undefined) {
      messages.push({ role: "user", content: JSON.stringify(value) })
    }
    messages.push(...extraMessages)
    if (state.outputSchema === undefined) return { messages }
    return {
      messages,
      responseFormat: {
        name: "output",
        strict: true,
        schema: jsonSchemaOf(state.outputSchema, "output"),
      },
    }
  }

  return {
    instruction: state.instruction,
    input(schema) {
      return build({ ...state, inputSchema: schema })
    },
    output(schema) {
      return build({ ...state, outputSchema: schema })
    },
    request: buildRequest,
    async run(input, options) {
      const request = await buildRequest(input, options.messages ?? [])
      let raw = await options.complete(request)

      // No output contract → the raw text IS the result.
      if (state.outputSchema === undefined) return raw as Output

      const healAttempts = Math.max(0, options.healAttempts ?? 1)
      for (let attempt = 0; ; attempt++) {
        let parsed: unknown
        let issues: ReadonlyArray<StandardIssue>
        try {
          parsed = JSON.parse(unfence(raw))
          const outcome = await validateStandard(state.outputSchema, parsed)
          if (outcome.ok) return outcome.value as Output
          issues = outcome.issues
        } catch {
          issues = [{ message: "reply is not valid JSON" }]
        }
        if (options.heal === undefined || attempt >= healAttempts) {
          throw new PromptOutputError(issues, raw)
        }
        raw = await options.heal({ raw, issues, request })
      }
    },
  }
}

/**
 * Define a type-safe prompt. Chain `.input()` / `.output()` with Standard Schemas, then `.run()`
 * with a provider `complete` fn. Immutable — each chain step returns a new prompt.
 */
export function prompt(instruction: string): Prompt<undefined, string> {
  return build({ instruction })
}
