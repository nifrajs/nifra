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

  test("a property named like an annotation keyword is part of the digest", async () => {
    for (const name of ["title", "description", "default", "example", "examples"]) {
      const asString = await bodyDigest(
        `{"type":"object","properties":{"${name}":{"type":"string"}}}`,
      )
      const asNumber = await bodyDigest(
        `{"type":"object","properties":{"${name}":{"type":"number"}}}`,
      )
      expect(asString?.request).not.toBe(asNumber?.request)
    }
  })

  test("instance data in enum and const is compared whole", async () => {
    expect((await bodyDigest('{"enum":[{"title":"a"}]}'))?.request).not.toBe(
      (await bodyDigest('{"enum":[{"title":"b"}]}'))?.request,
    )
    expect((await bodyDigest('{"const":{"default":1}}'))?.request).not.toBe(
      (await bodyDigest('{"const":{"default":2}}'))?.request,
    )
  })

  test("editing an annotation on a schema is not a contract change", async () => {
    expect(
      (
        await bodyDigest(
          '{"type":"object","title":"A","properties":{"n":{"type":"string","description":"x"}}}',
        )
      )?.request,
    ).toBe(
      (
        await bodyDigest(
          '{"type":"object","title":"B","properties":{"n":{"type":"string","description":"y"}}}',
        )
      )?.request,
    )
  })

  test("a schema without such names keeps the digest an earlier release wrote", async () => {
    const jsonSchema: unknown = JSON.parse(
      '{"type":"object","title":"User","description":"A user","required":["name","tags"],"properties":{"name":{"type":"string","description":"display name","default":"anon","examples":["Ada"]},"tags":{"type":"array","items":{"type":"string","enum":["a","b"]}},"meta":{"type":"object","additionalProperties":{"type":"number"},"example":{"x":1}}},"$defs":{"Id":{"type":"string","format":"uuid","title":"Id"}},"anyOf":[{"required":["name"]}]}',
    )
    const body = carrying(jsonSchema)
    const lock = await buildContractsLock(server().post("/x", { body, response: body }, () => 1))
    expect(lock.routes["POST /x"]).toEqual({
      request: "bf924b715378ebc058a0e6db8dbf747d6ef7a9b199941ecf936ddb849814fa4a",
      response: "0635694117631da47d2db592e8997bcdaadbc65eaee4c079d62988f34210692a",
    })
  })
})
