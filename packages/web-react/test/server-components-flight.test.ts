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

test("public Flight stream publishes a complete row before the source ends and abort cancels it", async () => {
  const encoder = new TextEncoder()
  const abort = new AbortController()
  let cancelSource!: () => void
  const sourceCancelled = new Promise<void>((resolve) => {
    cancelSource = resolve
  })
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('0:["$","p",null,{"children":"fast"},"$1","$2",1]\n'))
    },
    cancel() {
      cancelSource()
    },
  })
  const output = await publicFlightStream(source, abort.signal)
  const reader = output.getReader()
  const first = await reader.read()
  expect(first.done).toBe(false)
  expect(new TextDecoder().decode(first.value)).toContain("fast")

  abort.abort()
  await sourceCancelled
})

test("public Flight stream grows and compacts its buffer while preserving split rows", async () => {
  const encoder = new TextEncoder()
  const value = "x".repeat(1400)
  const bytes = encoder.encode(`0:D{"debug":"private"}\n1:${JSON.stringify(value)}\n2:"last"\n`)
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 32))
      controller.enqueue(bytes.subarray(32, 768))
      controller.enqueue(bytes.subarray(768))
      controller.close()
    },
  })
  const stream = await publicFlightStream(source, new AbortController().signal)
  expect(await new Response(stream).text()).toBe(`1:${JSON.stringify(value)}\n2:"last"\n`)
})

test("public Flight stream refuses empty, oversized, malformed and incomplete transport rows", async () => {
  const encoder = new TextEncoder()
  const sources: readonly Uint8Array[][] = [
    [],
    [new Uint8Array(0)],
    [encoder.encode("a".repeat(129))],
    [encoder.encode(`0:T${"f".repeat(17)}`)],
    [encoder.encode("0:Tz,payload\n")],
    [encoder.encode('0:"unterminated"')],
  ]
  for (const chunks of sources) {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    const stream = await publicFlightStream(source, new AbortController().signal)
    await expect(stream.getReader().read()).rejects.toThrow()
  }
})

test("public Flight stream forwards a downstream cancel to its source", async () => {
  const encoder = new TextEncoder()
  let cancelled = 0
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('0:"public"\n'))
    },
    cancel() {
      cancelled++
    },
  })
  const stream = await publicFlightStream(source, new AbortController().signal)
  const reader = stream.getReader()
  expect(await reader.read()).toMatchObject({ done: false })
  await reader.cancel()
  expect(cancelled).toBe(1)
})

test("public Flight cancellation waits for source cleanup before settling", async () => {
  let finishCancel: (() => void) | undefined
  let sourceCancelled = false
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      sourceCancelled = true
      return new Promise<void>((resolve) => {
        finishCancel = resolve
      })
    },
  })
  const stream = await publicFlightStream(source, new AbortController().signal)
  const reader = stream.getReader()
  let settled = false
  const cancelling = reader.cancel().then(() => {
    settled = true
  })
  await Promise.resolve()

  expect(sourceCancelled).toBe(true)
  expect(settled).toBe(false)
  finishCancel?.()
  await cancelling
  expect(settled).toBe(true)
})

test("public Flight stream parses split byte-length rows and an empty buffer before EOF", async () => {
  const encoder = new TextEncoder()
  const text = "streamed text"
  const row = `a:T${encoder.encode(text).length.toString(16)},${text}`
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("a"))
      controller.enqueue(encoder.encode(":T"))
      controller.enqueue(encoder.encode(row.slice(3, row.indexOf(","))))
      controller.enqueue(encoder.encode(row.slice(row.indexOf(","))))
      controller.close()
    },
  })

  const stream = await publicFlightStream(source, new AbortController().signal)
  expect(await new Response(stream).text()).toBe(row)
})

test("public Flight contains source reader cleanup failures", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('0:"public"\n'))
      controller.close()
    },
  })
  const getReader = source.getReader.bind(source)
  Object.defineProperty(source, "getReader", {
    configurable: true,
    value: () => {
      const reader = getReader()
      Object.defineProperty(reader, "releaseLock", {
        configurable: true,
        value: () => {
          throw new Error("simulated source reader cleanup race")
        },
      })
      return reader
    },
  })

  const stream = await publicFlightStream(source, new AbortController().signal)
  expect(await new Response(stream).text()).toContain('0:"public"\n')
})

test("public Flight waits out a rejected source cancellation and releases admission", async () => {
  let cancelled = false
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
      return Promise.reject(new Error("source cancellation failed"))
    },
  })
  const stream = await publicFlightStream(source, new AbortController().signal)
  await expect(stream.cancel("client disconnected")).resolves.toBeUndefined()
  expect(cancelled).toBe(true)
})
