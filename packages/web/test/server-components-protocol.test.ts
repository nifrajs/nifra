import { expect, test } from "bun:test"
import { componentFrames, readComponentFrames } from "../src/server-components/frames.ts"
import {
  type ComponentRequest,
  componentRequestHeader,
  readComponentRequest,
} from "../src/server-components/protocol.ts"

test("empty transport chunks are rejected without spinning until the operation deadline", async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array())
    },
    cancel() {
      cancelled = true
    },
  })
  await expect(readComponentFrames(stream, new AbortController().signal)).rejects.toMatchObject({
    code: "component_protocol",
  })
  expect(cancelled).toBe(true)
})

const selection: ComponentRequest = {
  v: 1,
  build: "build_1",
  reference: "component_1",
  key: "example",
  parent: null,
  generation: 1,
  routeEpoch: 0,
  authEpoch: 0,
  input: { id: "example" },
}
const request = (headers: HeadersInit): Request =>
  new Request("https://fixture.test/products/example", { headers })

test("the owner GET channel validates the closed envelope and same-origin metadata", () => {
  const header = componentRequestHeader(selection)
  expect(
    readComponentRequest(request({ "x-nifra-component": header, "sec-fetch-site": "same-origin" })),
  ).toEqual(selection)
  for (const headers of [
    { "x-nifra-component": header },
    { "x-nifra-component": header, "sec-fetch-site": "cross-site" },
    {
      "x-nifra-component": header,
      "sec-fetch-site": "same-origin",
      origin: "https://foreign.test",
    },
    { "x-nifra-component": header, "sec-fetch-site": "same-origin", "x-nifra-data": "1" },
    { "x-nifra-component": header + "," + header, "sec-fetch-site": "same-origin" },
  ])
    expect(() => readComponentRequest(request(headers))).toThrow()
  expect(() =>
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: This deliberate type bypass proves the runtime rejects undeclared fields instead of trusting compile-time types.
    componentRequestHeader({ ...selection, extra: "field" } as ComponentRequest),
  ).toThrow()
})

test("every UTF-8 and frame-header split decodes the same complete bounded payload", async () => {
  const value = { html: "<p>\u03b1\ud83d\ude00\u03c9</p>", payload: { public: "example" } }
  const bytes = new Uint8Array(await new Response(componentFrames({ v: 1 }, value)).arrayBuffer())
  for (let at = 1; at < bytes.length; at++) {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, at))
        controller.enqueue(bytes.slice(at))
        controller.close()
      },
    })
    expect(await readComponentFrames(source, new AbortController().signal)).toEqual({
      metadata: { v: 1 },
      value,
    })
  }
})

test("a truncated stream or trailing frame never publishes partial content", async () => {
  const bytes = new Uint8Array(
    await new Response(componentFrames({ v: 1 }, { html: "<p>example</p>" })).arrayBuffer(),
  )
  for (const invalid of [bytes.slice(0, -1), new Uint8Array([...bytes, 3, 0, 0, 0, 0])]) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(invalid)
        controller.close()
      },
    })
    await expect(readComponentFrames(stream, new AbortController().signal)).rejects.toMatchObject({
      code: "component_protocol",
    })
  }
})

test("one-byte transport chunks have the same aggregate limit as ordinary chunks", async () => {
  const bytes = new Uint8Array(
    await new Response(componentFrames({ v: 1 }, { html: "example" })).arrayBuffer(),
  )
  let position = 0
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position === bytes.length) controller.close()
      else controller.enqueue(bytes.slice(position, ++position))
    },
  })
  expect((await readComponentFrames(source, new AbortController().signal)).value).toEqual({
    html: "example",
  })
})
