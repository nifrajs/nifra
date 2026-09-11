import { describe, expect, test } from "bun:test"
import { assembleContext, ContextBudgetError, collectContext } from "../src/context.ts"

describe("context assembler", () => {
  test("keeps required items and admits the highest-priority optional items within budget", () => {
    const result = assembleContext(
      [
        { id: "system", kind: "instruction", content: "base", required: true },
        { id: "low", kind: "retrieval", content: "low", priority: 1 },
        { id: "high", kind: "memory", content: "high", priority: 2 },
      ],
      {
        budget: { maxTokens: 9 },
        tokenCounter: (text) => text.length,
        separator: "\n",
      },
    )

    expect(result.text).toBe("base\nhigh")
    expect(result.items.map((item) => item.id)).toEqual(["system", "high"])
    expect(result.includedIds).toEqual(["system", "high"])
    expect(result.omittedIds).toEqual(["low"])
    expect(result.tokens).toBe(9)
  })

  test("collects asynchronous sources in declaration order and attributes their items", async () => {
    const result = await collectContext(
      { task: "find it" },
      [
        {
          id: "memory",
          async load() {
            return [{ id: "memory.fact", kind: "memory", content: "fact" }]
          },
        },
        {
          id: "retrieval",
          load() {
            return [{ id: "retrieval.hit", kind: "retrieval", content: "hit" }]
          },
        },
      ],
      { budget: { maxTokens: 8 }, tokenCounter: (text) => text.length, separator: "\n" },
    )

    expect(result.text).toBe("fact\nhit")
    expect(result.items.map((item) => item.source)).toEqual(["memory", "retrieval"])
  })

  test("fails closed when required context cannot fit", () => {
    expect(() =>
      assembleContext(
        [{ id: "required", kind: "instruction", content: "too long", required: true }],
        { budget: { maxTokens: 3 }, tokenCounter: (text) => text.length },
      ),
    ).toThrow(ContextBudgetError)
  })

  test("rejects duplicate item ids and malformed source descriptors", async () => {
    expect(() =>
      assembleContext(
        [
          { id: "same", kind: "memory", content: "one" },
          { id: "same", kind: "retrieval", content: "two" },
        ],
        { budget: { maxTokens: 20 } },
      ),
    ).toThrow("duplicate item id same")

    await expect(
      collectContext({}, [{ id: "not a source", load: () => [] }], { budget: { maxTokens: 20 } }),
    ).rejects.toThrow("context: source is invalid")
  })

  test("does not retain mutable caller item objects", () => {
    const item = { id: "fact", kind: "memory", content: "original" }
    const result = assembleContext([item], { budget: { maxTokens: 20 } })

    item.content = "changed after assembly"
    expect(result.text).toBe("original")
    expect(result.items[0]).not.toBe(item)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.items)).toBe(true)
  })
})
