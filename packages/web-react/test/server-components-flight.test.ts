import { expect, test } from "bun:test"
import { publicFlight, publicFlightStream } from "../src/server-components/flight.ts"

test("public Flight drops server debug references, stacks and console payloads without changing native props", () => {
  const stream =
    '1:D{"private":"DEBUG_PRIVATE_SENTINEL"}\n2:W["CONSOLE_PRIVATE_SENTINEL"]\n0:["$","section",null,{"children":["$","p",null,{"children":"Public"},"$1","$9",1]},"$1","$8",1]\n'
  const text = new TextDecoder().decode(publicFlight(new TextEncoder().encode(stream)))
  expect(text).toBe(
    '0:["$","section",null,{"children":["$","p",null,{"children":"Public"},null,null,1]},null,null,1]\n',
  )
})
test("public Flight keeps byte-length framed UTF-8 text and sanitizes errors", () => {
  const text = "Public\n\u00e9"
  const stream =
    "a:T" +
    new TextEncoder().encode(text).length.toString(16) +
    "," +
    text +
    '0:"$a"\n1:E{"message":"PRIVATE_SENTINEL","stack":"source"}\n'
  const output = new TextDecoder().decode(publicFlight(new TextEncoder().encode(stream)))
  expect(output).toContain(text + '0:"$a"\n')
  expect(output).not.toContain("PRIVATE_SENTINEL")
  expect(output).toContain("component_failed")
  expect(() => publicFlight(new TextEncoder().encode("a:Tff,truncated"))).toThrow(
    "component_protocol",
  )
})
test("public Flight preserves React's missing-key validation bit", () => {
  expect(
    new TextDecoder().decode(
      publicFlight(
        new TextEncoder().encode('0:["$","p",null,{"children":"public"},"$1","$2",2]\n'),
      ),
    ),
  ).toBe('0:["$","p",null,{"children":"public"},null,null,2]\n')
})

test("public Flight rejects malformed framing, closure actions and excessive nested models", async () => {
  const encoder = new TextEncoder()
  for (const source of ["bad-id:{}\n", "0", "0:Tz,broken", "0:{\n", '0:"$Fprivate"\n'])
    expect(() => publicFlight(encoder.encode(source))).toThrow()
  const deep = "[".repeat(130) + "null" + "]".repeat(130)
  expect(() => publicFlight(encoder.encode(`0:${deep}\n`))).toThrow("component_limit")
  const signal = new AbortController().signal
  const stream = await publicFlightStream(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('0:I["client",[],"Counter"]\n1:42\n'))
        controller.close()
      },
    }),
    signal,
  )
  expect(await new Response(stream).text()).toBe('0:I["client",[],"Counter"]\n1:42\n')
})
