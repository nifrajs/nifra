import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { toCatalogEntry } from "../src/tool-catalog.ts"
import { defineTool } from "../src/tool-contract.ts"

describe("tool catalog projection", () => {
  test("projects every model-visible policy field without moving enforcement", () => {
    const tool = defineTool({
      name: "orders.refund",
      description: "Refund an order.",
      input: t.object({ orderId: t.string() }),
      output: t.object({ ok: t.boolean() }),
      capability: "orders.refund",
      sensitivity: "sensitive",
      approval: { kind: "threshold", level: 2 },
      idempotency: { scope: "durable", key: (input) => input.orderId },
      annotations: {
        title: "Refund order",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      execute: () => ({ ok: true }),
    })

    expect(toCatalogEntry(tool)).toEqual({
      name: "orders.refund",
      description: "Refund an order.",
      inputSchema: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
        additionalProperties: false,
      },
      capability: "orders.refund",
      sensitivity: "sensitive",
      approval: { kind: "threshold", level: 2 },
      idempotent: true,
      annotations: {
        title: "Refund order",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    })
  })
})
