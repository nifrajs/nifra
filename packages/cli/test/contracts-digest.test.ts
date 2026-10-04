import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import type { StandardSchemaV1 } from "@nifrajs/core/schema"
import { buildContractsLock, type ContractDigest } from "../src/contracts.ts"

function carrying(jsonSchema: unknown): StandardSchemaV1 & { readonly jsonSchema: unknown } {
  return {
    "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
    jsonSchema,
  }
}

async function bodyDigest(json: string): Promise<ContractDigest | undefined> {
  const schema: unknown = JSON.parse(json)
  const lock = await buildContractsLock(server().post("/x", { body: carrying(schema) }, () => 1))
  return lock.routes["POST /x"]
}

describe("contracts digest", () => {
  test("a property named __proto__ is part of the request digest", async () => {
    const asString = await bodyDigest(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    )
    const asNumber = await bodyDigest(
      '{"type":"object","properties":{"__proto__":{"type":"number"}}}',
    )
    expect(asString?.request).not.toBe(asNumber?.request)
  })
})
