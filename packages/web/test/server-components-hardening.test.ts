import { expect, test } from "bun:test"
import type { StandardSchemaV1 } from "@nifrajs/core/server"
import { componentFrames, readComponentFrames } from "../src/server-components/frames.ts"
import { validateComponentHTML } from "../src/server-components/html.ts"
import { assertComponentSchema } from "../src/server-components/schema.ts"
import {
  bytesStream,
  decodeComponentBytes,
  encodeComponentBytes,
  readComponentBytes,
} from "../src/server-components/stream.ts"

const signal = () => new AbortController().signal
const encode = (value: string) => new TextEncoder().encode(value)
function schema(jsonSchema: unknown): StandardSchemaV1 & { readonly jsonSchema: unknown } {
  return {
    jsonSchema,
    "~standard": { version: 1, vendor: "fixture", validate: (value) => ({ value }) },
  }
}

test("closed public schemas resolve local refs and reject cycles, foreign refs and opaque branches", () => {
  const shared = { type: "string" }
  expect(() =>
    assertComponentSchema(
      schema({
        type: "object",
        additionalProperties: false,
        properties: { a: shared, b: shared, c: { $ref: "#/$defs/name" } },
        $defs: { name: { oneOf: [{ type: "string" }, { type: "null" }] } },
      }),
    ),
  ).not.toThrow()
  expect(() =>
    assertComponentSchema(
      schema({ type: "array", items: [{ type: "integer" }, { type: "boolean" }] }),
    ),
  ).not.toThrow()
  expect(() =>
    assertComponentSchema(schema({ allOf: [{ type: "string" }, { anyOf: [{ type: "string" }] }] })),
  ).not.toThrow()
  let deep: unknown = { type: "string" }
  for (let index = 0; index < 34; index++) deep = { type: "array", items: deep }
  for (const value of [
    undefined,
    [],
    { type: "object", additionalProperties: false, properties: [] },
    { type: "object", additionalProperties: false, properties: { constructor: shared } },
    { $ref: "https://fixture.test/schema" },
    { $ref: "#/$defs/missing" },
    { $ref: "#/constructor" },
    { anyOf: [] },
    { oneOf: "opaque" },
    { $ref: "#/$defs/self", $defs: { self: { $ref: "#/$defs/self" } } },
    { type: "object", additionalProperties: false, properties: { x: null } },
    deep,
  ])
    expect(() => assertComponentSchema(schema(value))).toThrow()
})

test("bounded byte snapshots preserve UTF-8 and reject empty, oversized and cancelled sources", async () => {
  const data = encode("Public é\n")
  expect(decodeComponentBytes(encodeComponentBytes(data))).toEqual(data)
  expect(await readComponentBytes(bytesStream(data), signal(), data.length)).toEqual(data)
  await expect(
    readComponentBytes(bytesStream(data), signal(), data.length - 1),
  ).rejects.toMatchObject({ code: "component_limit" })
  await expect(readComponentBytes(bytesStream(new Uint8Array()), signal())).rejects.toMatchObject({
    code: "component_protocol",
  })
  for (const value of [null, "!", "A", "A===", "AAAA=", "a".repeat(1500000)])
    expect(() => decodeComponentBytes(value)).toThrow()
  const before = new AbortController()
  before.abort()
  await expect(
    readComponentBytes(
      new ReadableStream({
        cancel() {
          throw new Error("transport closed")
        },
      }),
      before.signal,
    ),
  ).rejects.toMatchObject({ code: "component_cancelled" })
  const during = new AbortController()
  const pending = readComponentBytes(
    new ReadableStream({
      cancel() {
        throw new Error("transport closed")
      },
    }),
    during.signal,
  )
  during.abort()
  await expect(pending).rejects.toMatchObject({ code: "component_cancelled" })
})

test("frame cancellation and idle failure cancel the source without replacing the safe error", async () => {
  let cancelled = 0
  const abort = new AbortController()
  const pending = readComponentFrames(
    new ReadableStream({
      cancel() {
        cancelled++
        throw new Error("transport closed")
      },
    }),
    abort.signal,
  )
  abort.abort()
  await expect(pending).rejects.toMatchObject({ code: "component_cancelled" })
  expect(cancelled).toBe(1)
  const idle = readComponentFrames(
    new ReadableStream({
      cancel() {
        cancelled++
      },
    }),
    signal(),
  )
  await expect(idle).rejects.toMatchObject({ code: "component_timeout" })
  expect(cancelled).toBe(2)
}, 10000)

test("framed output rejects oversized metadata and malformed JSON without publishing a value", async () => {
  expect(() => componentFrames({ text: "x".repeat(300000) }, {})).toThrow()
  const bytes = await readComponentBytes(componentFrames({}, { text: "safe" }), signal())
  const corrupted = bytes.slice()
  corrupted[9] = 0xff
  await expect(readComponentFrames(bytesStream(corrupted), signal())).rejects.toMatchObject({
    code: "component_protocol",
  })
  const invalid = bytes.slice()
  invalid[9] = "!".charCodeAt(0)
  await expect(readComponentFrames(bytesStream(invalid), signal())).rejects.toMatchObject({
    code: "component_protocol",
  })
})

test("SSR token policy rejects NUL, document declarations and malformed character references", () => {
  for (const html of ["\0", "<!DOCTYPE html>", '<div title="&#x110000;">text</div>'])
    expect(() => validateComponentHTML(html)).toThrow()
  expect(() => validateComponentHTML("<!--public--><p>Safe &amp; escaped</p>")).not.toThrow()
})

test("SSR token policy sees markup that a browser reads inside title, textarea and other text-mode elements", () => {
  const img = "<img src=x onerror=alert(1)>"
  for (const html of [
    `<title><!--</title>${img}-->`,
    `<textarea><!--</textarea>${img}-->`,
    `<TEXTAREA><!--</TextArea >${img}-->`,
    `<noembed><!--</noembed>${img}-->`,
    `<noframes><!--</noframes>${img}-->`,
    // An HTML title before an SVG one: no single tokenizer mode reads both as a browser does.
    `<title><!--</title><svg><title>${img}</title></svg>-->`,
    `<textarea></textareax>${img}</textarea>`,
    "<title>never closed",
    "<title>a < b</title>",
  ])
    expect(() => validateComponentHTML(html)).toThrow()
  for (const html of [
    "<textarea name=note>a &lt; b &amp; &lt;!-- c --&gt;</textarea>",
    "<svg viewBox='0 0 1 1'><title>Close</title><path d='M0 0'/></svg>",
    "<title></title><p>after</p>",
    "<textarea/>text</textarea>",
  ])
    expect(() => validateComponentHTML(html)).not.toThrow()
})
