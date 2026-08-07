import { describe, expect, test } from "bun:test"
import { multipartResponse } from "../src/index.ts"

describe("multipartResponse()", () => {
  test("streams parts with per-part headers and a stable boundary", async () => {
    const response = multipartResponse(
      [
        { headers: { "content-type": "text/plain" }, body: "hello" },
        { headers: { "content-type": "application/json" }, body: '{"ok":true}' },
      ],
      { boundary: "test-boundary" },
    )

    expect(response.headers.get("content-type")).toBe("multipart/mixed; boundary=test-boundary")
    expect(await response.text()).toBe(
      "--test-boundary\r\n" +
        "content-type: text/plain\r\n\r\n" +
        "hello\r\n" +
        "--test-boundary\r\n" +
        "content-type: application/json\r\n\r\n" +
        '{"ok":true}\r\n' +
        "--test-boundary--\r\n",
    )
  })

  test("cancels an active part stream when the response is canceled", async () => {
    let canceled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("payload"))
      },
      cancel() {
        canceled = true
      },
    })
    const response = multipartResponse([{ body }], { boundary: "cancel-test" })
    const reader = response.body!.getReader()

    await reader.read()
    await reader.read()
    await reader.read()
    await reader.cancel()

    expect(canceled).toBe(true)
  })

  test("supports binary body variants and all supported header initializers", async () => {
    const buffer = new Uint8Array([66]).buffer
    const view = new DataView(new Uint8Array([67]).buffer)
    const response = multipartResponse(
      [
        { headers: new Headers({ "x-kind": "headers" }), body: new Uint8Array([65]) },
        { headers: [["x-kind", "array"]], body: buffer },
        { body: view },
        { body: new Blob(["D"]) },
        {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([69]))
              controller.close()
            },
          }),
        },
      ],
      { boundary: "binary-test", subtype: "form-data", status: 201 },
    )

    expect(response.status).toBe(201)
    const text = await response.text()
    expect(text).toContain("A")
    expect(text).toContain("B")
    expect(text).toContain("C")
    expect(text).toContain("D")
    expect(text).toContain("E")
  })

  test("rejects invalid boundaries, unsafe headers, and malformed parts", async () => {
    expect(() => multipartResponse([], { boundary: "bad\nvalue" })).toThrow(/boundary/)
    expect(() => multipartResponse([], { boundary: "trailing-space " })).toThrow(/boundary/)

    const unsafe = multipartResponse([{ headers: { "x-bad": "bad\nvalue" }, body: "x" }], {
      boundary: "unsafe",
    })
    await expect(unsafe.text()).rejects.toThrow()

    const control = multipartResponse([{ headers: { "x-bad": "bad\u0001value" }, body: "x" }], {
      boundary: "control",
    })
    await expect(control.text()).rejects.toThrow()

    const malformed = multipartResponse([null as unknown as { body: string }], {
      boundary: "malformed",
    })
    await expect(malformed.text()).rejects.toThrow(/every part/)
  })
})
