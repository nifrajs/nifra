import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { PromptInputError, PromptOutputError, type PromptRequest, prompt } from "../src/index.ts"

const contact = prompt("Extract the contact from the text.")
  .input(t.object({ text: t.string() }))
  .output(t.object({ name: t.string(), email: t.string({ format: "email" }) }))

describe("request building", () => {
  test("renders system instruction + JSON input and carries the output JSON Schema", async () => {
    const request = await contact.request({ text: "Reach Ada at ada@lovelace.dev" })
    expect(request.messages[0]).toEqual({
      role: "system",
      content: "Extract the contact from the text.",
    })
    expect(JSON.parse(request.messages[1]!.content)).toEqual({
      text: "Reach Ada at ada@lovelace.dev",
    })
    expect(request.responseFormat?.strict).toBe(true)
    const schema = request.responseFormat?.schema as Record<string, unknown>
    expect(schema.type).toBe("object")
    expect(Object.keys(schema.properties as object)).toEqual(["name", "email"])
    // Validation-only internals never leak into the provider payload.
    expect("~standard" in schema).toBe(false)
  })

  test("input is validated before any provider call", async () => {
    await expect(
      contact.run({ text: 42 } as unknown as { text: string }, {
        complete: () => {
          throw new Error("must not be called")
        },
      }),
    ).rejects.toBeInstanceOf(PromptInputError)
  })

  test("a validation-only output schema is rejected at request time", async () => {
    const opaque = prompt("x").output({
      "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
    } as never)
    await expect(opaque.request(undefined)).rejects.toThrow(/no JSON Schema metadata/)
  })
})

describe("run", () => {
  test("parses and returns the typed output", async () => {
    const result = await contact.run(
      { text: "..." },
      { complete: () => JSON.stringify({ name: "Ada", email: "ada@lovelace.dev" }) },
    )
    expect(result).toEqual({ name: "Ada", email: "ada@lovelace.dev" })
  })

  test("strips a markdown fence around the reply", async () => {
    const result = await contact.run(
      { text: "..." },
      { complete: () => '```json\n{"name":"Ada","email":"ada@lovelace.dev"}\n```' },
    )
    expect(result.name).toBe("Ada")
  })

  test("no output schema → raw text result", async () => {
    const haiku = prompt("Write a haiku.")
    const result = await haiku.run(undefined, { complete: () => "still pond / a frog" })
    expect(result).toBe("still pond / a frog")
  })

  test("invalid reply throws PromptOutputError with issues + raw", async () => {
    const failing = contact.run(
      { text: "..." },
      { complete: () => JSON.stringify({ name: "Ada" }) },
    )
    await expect(failing).rejects.toBeInstanceOf(PromptOutputError)
    const error = (await failing.catch((e) => e)) as PromptOutputError
    expect(error.issues.length).toBeGreaterThan(0)
    expect(error.raw).toContain("Ada")
  })

  test("non-JSON reply reports a parse issue", async () => {
    const error = (await contact
      .run({ text: "..." }, { complete: () => "sorry, I cannot do that" })
      .catch((e) => e)) as PromptOutputError
    expect(error).toBeInstanceOf(PromptOutputError)
    expect(error.issues[0]?.message).toBe("reply is not valid JSON")
  })

  test("heal hook repairs a failed reply and its result is validated", async () => {
    const healed = await contact.run(
      { text: "..." },
      {
        complete: () => "not json",
        heal: ({ issues }) => {
          expect(issues[0]?.message).toBe("reply is not valid JSON")
          return JSON.stringify({ name: "Ada", email: "ada@lovelace.dev" })
        },
      },
    )
    expect(healed.email).toBe("ada@lovelace.dev")
  })

  test("heal attempts are bounded", async () => {
    let heals = 0
    const failing = contact.run(
      { text: "..." },
      {
        complete: () => "not json",
        heal: () => {
          heals++
          return "still not json"
        },
        healAttempts: 2,
      },
    )
    await expect(failing).rejects.toBeInstanceOf(PromptOutputError)
    expect(heals).toBe(2)
  })

  test("extra messages are appended to the request", async () => {
    let seen: PromptRequest | undefined
    await contact.run(
      { text: "..." },
      {
        messages: [{ role: "assistant", content: "example output" }],
        complete: (request) => {
          seen = request
          return JSON.stringify({ name: "A", email: "a@b.co" })
        },
      },
    )
    expect(seen?.messages.at(-1)).toEqual({ role: "assistant", content: "example output" })
  })
})
