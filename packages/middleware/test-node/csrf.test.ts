import assert from "node:assert/strict"
import test from "node:test"
import { server } from "@nifrajs/core"
import { csrf } from "@nifrajs/middleware"

for (const contentType of [
  "application/x-www-form-urlencoded",
  "multipart/form-data; boundary=test",
]) {
  test(`CSRF rejects an oversized open ${contentType} stream on Node`, async () => {
    let cancelled = false
    let handled = false
    let producer: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        producer = controller
        controller.enqueue(new Uint8Array(32))
        controller.enqueue(new Uint8Array(33))
      },
      cancel() {
        cancelled = true
        // Rejection must also finish when upstream cleanup does not settle.
        return new Promise<void>(() => {})
      },
    })
    const app = server()
      .use(csrf({ secret: "0123456789abcdef0123456789abcdef", field: "_csrf", fieldMaxBytes: 64 }))
      .post("/mutate", () => {
        handled = true
        return { ok: true }
      })
    const init = {
      method: "POST",
      headers: {
        origin: "http://app.test",
        cookie: "csrf-token=unsigned",
        "content-type": contentType,
      },
      body,
      duplex: "half" as const,
    }
    const response = app.fetch(new Request("http://app.test/mutate", init))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        response,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("CSRF rejection waited for the stream")), 500)
        }),
      ])
      assert.equal(result.status, 403)
      assert.deepEqual(await result.json(), { ok: false, error: "csrf_failed" })
      assert.equal(handled, false)
      assert.equal(cancelled, true)
    } finally {
      clearTimeout(timer)
      if (!cancelled) producer?.close()
    }
  })
}
